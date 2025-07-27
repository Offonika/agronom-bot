require('dotenv').config();
const { Queue, Worker } = require('bullmq');
const { Pool } = require('pg');
const { execFileSync } = require('child_process');

const connection = { connectionString: process.env.REDIS_URL || 'redis://localhost:6379' };
const queueName = 'retry-diagnosis';

const MAX_RETRIES = parseInt(process.env.RETRY_LIMIT || '3', 10);
const queue = new Queue(queueName, { connection });

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function schedule() {
  await queue.add(
    'retry',
    {},
    {
      repeat: { cron: '0 1 * * *', tz: 'Europe/Moscow' },
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
          const out = execFileSync(
            'python3',
            [
              '-c',
              "import sys,json; from app.services.gpt import call_gpt_vision_stub; print(json.dumps(call_gpt_vision_stub(sys.argv[1])))",
              row.file_id,
            ],
            { encoding: 'utf8' }
          );
          const resp = JSON.parse(out.trim() || '{}');
          await client.query(
            "UPDATE photos SET crop=$1, disease=$2, confidence=$3, status='ok' WHERE id=$4",
            [resp.crop || null, resp.disease || null, resp.confidence || 0, row.id]
          );
          success += 1;
        } catch (err) {
          await client.query(
            "UPDATE photos SET retry_attempts = retry_attempts + 1, status = CASE WHEN retry_attempts + 1 >= $2 THEN 'failed' ELSE 'retrying' END WHERE id=$1",
            [row.id, MAX_RETRIES]
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
  { connection }
);
