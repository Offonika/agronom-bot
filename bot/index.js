require('dotenv').config();
const { Telegraf } = require('telegraf');
const { Pool } = require('pg');
const { photoHandler, messageHandler, startHandler, subscribeHandler, buyProHandler } = require('./handlers');

const token = process.env.BOT_TOKEN_DEV;
if (!token) {
  throw new Error('BOT_TOKEN_DEV not set');
}

const pool = new Pool({
  connectionString:
    process.env.BOT_DATABASE_URL || process.env.DATABASE_URL,
});
const bot = new Telegraf(token);

bot.start((ctx) => startHandler(ctx, pool));

bot.command('subscribe', (ctx) => subscribeHandler(ctx, pool));

bot.on('photo', (ctx) => photoHandler(pool, ctx));

bot.on('message', messageHandler);

bot.action(/^proto\|/, (ctx) => {
  const [, product, val, unit, phi] = ctx.callbackQuery.data.split('|');
  const msg =
    `Препарат: ${product}\n` +
    `Доза: ${val} ${unit}\n` +
    `Срок ожидания (PHI): ${phi} дней`;
  ctx.answerCbQuery();
  return ctx.reply(msg);
});

bot.action('ask_expert', (ctx) => {
  ctx.answerCbQuery();
  return ctx.reply('Свяжитесь с экспертом для уточнения протокола.');
});

bot.action('buy_pro', (ctx) => buyProHandler(ctx, pool));

bot.launch().then(() => console.log('Bot started'));

// Gracefully close DB connections on termination
async function shutdown() {
  await pool.end();
  process.exit(0);
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

