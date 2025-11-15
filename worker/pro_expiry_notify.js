require('dotenv').config();
const { Queue, Worker } = require('bullmq');
const { Pool } = require('pg');

async function sendTgMessage(chatId, text) {
  const token = process.env.BOT_TOKEN_DEV;
  if (!token) {
    throw new Error('BOT_TOKEN_DEV not set');
  }
  const body = new URLSearchParams({ chat_id: String(chatId), text });
  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (!response.ok) {
      console.error(`Telegram API responded with status ${response.status}`);
      throw new Error(`Telegram API error: ${response.status}`);
    }
  } catch (err) {
    console.error('Failed to send Telegram message', err);
    throw err;
  }
}

async function notifyExpiringUsers(pool, sendMessage = sendTgMessage) {
  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      "SELECT tg_id FROM users WHERE pro_expires_at::date = (now() + interval '3 day')::date"
    );
    for (const row of rows) {
      try {
        await sendMessage(
          row.tg_id,
          'Ваша подписка PRO истекает через 3 дня. Продлите её, чтобы сохранить доступ.'
        );
      } catch (err) {
        console.error(`Failed to notify user ${row.tg_id}`, err);
      }
    }
    console.log(`Pro expiry notify: notified=${rows.length}`);
  } finally {
    client.release();
  }
}

module.exports = { notifyExpiringUsers };

if (require.main === module) {
  const connection = { url: process.env.REDIS_URL || 'redis://localhost:6379' };
  const queueName = 'pro-expiry-notify';
  const queue = new Queue(queueName, { connection });
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  async function schedule() {
    const jobs = await queue.getRepeatableJobs();
    const alreadyScheduled = jobs.some((job) => job.id === 'notify');
    if (alreadyScheduled) return;
    await queue.add(
      'notify',
      {},
      {
        jobId: 'notify',
        repeat: { cron: process.env.PRO_NOTIFY_CRON || '0 9 * * *', tz: 'Europe/Moscow' },
        removeOnComplete: true,
      }
    );
  }

  schedule();
  new Worker(queueName, () => notifyExpiringUsers(pool), { connection });
}
