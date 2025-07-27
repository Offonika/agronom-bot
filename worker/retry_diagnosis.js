require('dotenv').config();
const { Queue, Worker } = require('bullmq');
const { Pool } = require('pg');
const { callGptVisionStub } = require('./gpt_stub');

const connection = { connectionString: process.env.REDIS_URL || 'redis://localhost:6379' };
const queueName = 'retry-diagnosis';

const queue = new Queue(queueName, { connection });

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const retryCron = process.env.RETRY_CRON || '0 1 * * *';
const RETRY_CONCURRENCY = parseInt(process.env.RETRY_CONCURRENCY || '1', 10);
const RETRY_LIMIT = parseInt(process.env.RETRY_LIMIT || '3', 10);

console.log(`Retry diagnosis worker concurrency=${RETRY_CONCURRENCY}`);

async function schedule() {
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

new Worker(
  queueName,
  async () => {
    const client = await pool.connect();
    let processed = 0;
    let success = 0;
    let failed = 0;
    try {
      const { rows } = await client.query("SELECT id, file_id FROM photos WHERE status='pending'");
      processed = rows.length;
      for (const row of rows) {
        try {
          const resp = await callGptVisionStub(row.file_id);
          await client.query(
            "UPDATE photos SET crop=$1, disease=$2, confidence=$3, status='ok' WHERE id=$4",
            [resp.crop || null, resp.disease || null, resp.confidence || 0, row.id]
          );
          success += 1;
        } catch (err) {
          await client.query(
            "UPDATE photos SET retry_attempts=retry_attempts+1, " +
              "status=CASE WHEN retry_attempts+1 >= $2 THEN 'failed' ELSE 'retrying' END " +
              "WHERE id=$1",
            [row.id, RETRY_LIMIT]
          );
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
