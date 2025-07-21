require('dotenv').config();
const { Telegraf } = require('telegraf');
const { Pool } = require('pg');

const token = process.env.BOT_TOKEN_DEV;
if (!token) {
  throw new Error('BOT_TOKEN_DEV not set');
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const bot = new Telegraf(token);

bot.on('photo', async (ctx) => {
  const photo = ctx.message.photo[ctx.message.photo.length - 1];
  const { file_id, file_unique_id, width, height, file_size } = photo;
  const userId = ctx.from.id;
  console.log('Received photo', file_id);
  try {
    await pool.query(
      `INSERT INTO photos (user_id, file_id, file_unique_id, width, height, file_size, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'pending')`,
      [userId, file_id, file_unique_id, width, height, file_size]
    );
  } catch (err) {
    console.error('DB insert error', err);
  }
  await ctx.reply('Фото получено');
});

bot.on('message', (ctx) => {
  if (!ctx.message.photo) {
    console.log('Ignoring non-photo message');
  }
});

bot.launch().then(() => console.log('Bot started'));
