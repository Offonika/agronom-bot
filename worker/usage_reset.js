require('dotenv').config();
const { Queue, Worker } = require('bullmq');
const { Pool } = require('pg');

const connection = { connectionString: process.env.REDIS_URL || 'redis://localhost:6379' };
const queueName = 'usage-reset';

const queue = new Queue(queueName, { connection });

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function schedule() {
  await queue.add(
    'reset',
    {},
    {
      repeat: { cron: '5 0 1 * *', tz: 'Europe/Moscow' },
      removeOnComplete: true,
    }
  );
}

schedule();

new Worker(
  queueName,
  async () => {
    const client = await pool.connect();
    try {
      await client.query(
        "UPDATE photo_usage SET used=0 WHERE month < to_char(now() AT TIME ZONE 'Europe/Moscow', 'YYYY-MM')"
      );
      console.log('Photo usage counters reset');
    } finally {
      client.release();
    }
  },
  { connection }
);
