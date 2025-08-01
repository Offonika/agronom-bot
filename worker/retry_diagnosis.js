require('dotenv').config();
const http = require('http');
const { Queue, Worker } = require('bullmq');
const { Pool } = require('pg');
const { Counter, Registry, collectDefaultMetrics } = require('prom-client');
const { callGptVisionStub } = require('./gpt_stub');

const connection = { connectionString: process.env.REDIS_URL || 'redis://localhost:6379' };
const queueName = 'retry-diagnosis';

const queue = new Queue(queueName, { connection });
queue.on('error', (err) => {
  console.error('Redis error', err);
});

const register = new Registry();
collectDefaultMetrics({ register });
const failureCounter = new Counter({
  name: 'retry_failures_total',
  help: 'Total failed retry attempts',
  registers: [register],
});
const successCounter = new Counter({
  name: 'retry_success_total',
  help: 'Total successful retry attempts',
  registers: [register],
});
const processedCounter = new Counter({
  name: 'retry_processed_total',
  help: 'Total processed rows',
  registers: [register],
});

const METRICS_PORT = parseInt(process.env.METRICS_PORT || '9102', 10);
http
  .createServer(async (_req, res) => {
    res.setHeader('Content-Type', register.contentType);
    res.end(await register.metrics());
  })
  .listen(METRICS_PORT, () => {
    console.log(`Metrics server running on ${METRICS_PORT}`);
  });

const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;

async function notifySlack(text) {
  if (!SLACK_WEBHOOK_URL) return;
  try {
    await fetch(SLACK_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
  } catch (err) {
    console.error('Failed to send Slack notification', err);
  }
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const retryCron = process.env.RETRY_CRON || '0 1 * * *';
const RETRY_CONCURRENCY = parseInt(process.env.RETRY_CONCURRENCY || '1', 10);
const RETRY_LIMIT = parseInt(process.env.RETRY_LIMIT || '3', 10);

console.log(`Retry diagnosis worker concurrency=${RETRY_CONCURRENCY}`);

async function schedule() {
  try {
    await queue.waitUntilReady();
  } catch (err) {
    console.error('Redis connection failed', err);
    process.exit(1);
  }
  await queue.add(
    'retry',
    {},
    {
      repeat: { cron: retryCron, tz: 'Europe/Moscow' },
      removeOnComplete: true,
    }
  );
}

schedule();

const worker = new Worker(
  queueName,
  async () => {
    let client;
    try {
      client = await pool.connect();
    } catch (err) {
      console.error('DB connection failed', err);
      await notifySlack('Retry worker: unable to connect to DB');
      throw err;
    }
    let processed = 0;
    let success = 0;
    let failed = 0;
    try {
      const { rows } = await client.query("SELECT id, file_id, retry_attempts FROM photos WHERE status='pending'");
      processed = rows.length;
      for (const row of rows) {
        try {
          const resp = await callGptVisionStub(row.file_id);
          await client.query(
            "UPDATE photos SET crop=$1, disease=$2, confidence=$3, status='ok' WHERE id=$4",
            [resp.crop || null, resp.disease || null, resp.confidence || 0, row.id]
          );
          success += 1;
          successCounter.inc();
        } catch (err) {
          await client.query(
            "UPDATE photos SET retry_attempts=retry_attempts+1, " +
              "status=CASE WHEN retry_attempts+1 >= $2 THEN 'failed' ELSE 'retrying' END " +
              "WHERE id=$1",
            [row.id, RETRY_LIMIT]
          );
          failed += 1;
          failureCounter.inc();
          if (row.retry_attempts + 1 >= RETRY_LIMIT) {
            await notifySlack(`Diagnosis ${row.id} exceeded retry limit`);
          }
        }
      }
      processedCounter.inc(processed);
      console.log(
        `Retry diagnosis: processed=${processed} success=${success} failed=${failed}`
      );
    } finally {
      client.release();
    }
  },
  { connection, concurrency: RETRY_CONCURRENCY }
);
worker.on('error', (err) => {
  console.error('Worker error', err);
});
