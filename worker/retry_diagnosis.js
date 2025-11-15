require('dotenv').config();
const { Queue, Worker } = require('bullmq');
const { Pool } = require('pg');
const { callGptVisionStub } = require('./gpt_stub');
const prom = require('prom-client');

const connection = { url: process.env.REDIS_URL || 'redis://localhost:6379' };
const queueName = 'retry-diagnosis';

const queue = new Queue(queueName, { connection });

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const queueSizePending = new prom.Gauge({
  name: 'queue_size_pending',
  help: 'Number of pending photos awaiting diagnosis',
});

const retryCron = process.env.RETRY_CRON || '0 1 * * *';
const RETRY_CONCURRENCY = parseInt(process.env.RETRY_CONCURRENCY || '1', 10);
const RETRY_LIMIT = parseInt(process.env.RETRY_LIMIT || '3', 10);

console.log(`Retry diagnosis worker concurrency=${RETRY_CONCURRENCY}`);

async function schedule() {
  const jobs = await queue.getRepeatableJobs();
  const alreadyScheduled = jobs.some((job) => job.id === 'retry');
  if (alreadyScheduled) {
    return;
  }
  await queue.add(
    'retry',
    {},
    {
      jobId: 'retry',
      repeat: { cron: retryCron, tz: 'Europe/Moscow' },
      removeOnComplete: true,
    }
  );
}

schedule().catch(console.error);

new Worker(
  queueName,
  async () => {
    const client = await pool.connect();
    let processed = 0;
    let success = 0;
    let failed = 0;
    try {
      const { rows } = await client.query(
        "SELECT id, file_id, retry_attempts FROM photos WHERE status IN ('pending','retrying')"
      );
      processed = rows.length;
      for (const row of rows) {
        try {
          const resp = await callGptVisionStub(row.file_id);
          await client.query(
            "UPDATE photos SET crop=$1, disease=$2, confidence=$3, status='ok' WHERE id=$4",
            [resp.crop || null, resp.disease || null, resp.confidence || 0, row.id]
          );
          queueSizePending.dec();
          success += 1;
        } catch (err) {
          const attempts = row.retry_attempts + 1;
          const status = attempts >= RETRY_LIMIT ? 'failed' : 'retrying';
          await client.query(
            "UPDATE photos SET retry_attempts=$2, status=$3 WHERE id=$1",
            [row.id, attempts, status]
          );
          if (status === 'failed') {
            queueSizePending.dec();
          }
          failed += 1;
        }
      }
      console.log(
        `Retry diagnosis: processed=${processed} success=${success} failed=${failed}`
      );
    } finally {
      client.release();
    }
  },
  { connection, concurrency: RETRY_CONCURRENCY }
);
