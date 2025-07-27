require('dotenv').config();
const { Telegraf } = require('telegraf');
const { Pool } = require('pg');
const {
  photoHandler,
  messageHandler,
  startHandler,
  subscribeHandler,
  buyProHandler,
  retryHandler,
  historyHandler,
} = require('./handlers');

const token = process.env.BOT_TOKEN_DEV;
if (!token) {
  throw new Error('BOT_TOKEN_DEV not set');
}

const pool = new Pool({
  connectionString:
    process.env.BOT_DATABASE_URL || process.env.DATABASE_URL,
});
const bot = new Telegraf(token);

bot.telegram.setMyCommands([
  { command: 'start', description: 'Начать работу' },
  { command: 'help', description: 'Помощь' },
  { command: 'history', description: 'История запросов' },
  { command: 'subscribe', description: 'Купить PRO' },
]);

bot.start(async (ctx) => {
  await startHandler(ctx, pool);
  await bot.telegram.setChatMenuButton(ctx.chat.id, { type: 'commands' });
});

bot.command('subscribe', (ctx) => subscribeHandler(ctx, pool));

bot.command('history', (ctx) => historyHandler(ctx, 0));

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

bot.command('retry', (ctx) => {
  const [, id] = ctx.message.text.split(' ');
  if (id) return retryHandler(ctx, id);
  return ctx.reply('Укажите ID фото после команды /retry');
});

bot.action(/^retry\|/, (ctx) => {
  const [, id] = ctx.callbackQuery.data.split('|');
  ctx.answerCbQuery();
  return retryHandler(ctx, id);
});

bot.action(/^history\|/, (ctx) => {
  const [, off] = ctx.callbackQuery.data.split('|');
  const offset = Math.max(parseInt(off, 10) || 0, 0);
  ctx.answerCbQuery();
  return historyHandler(ctx, offset);
});

bot.action(/^info\|/, (ctx) => {
  const [, id] = ctx.callbackQuery.data.split('|');
  ctx.answerCbQuery();
  return retryHandler(ctx, id);
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

