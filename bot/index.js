require('dotenv').config();
const { Telegraf } = require('telegraf');
const { Pool } = require('pg');
const { photoHandler, messageHandler, retryHandler, getProductName } = require('./diagnosis');
const { subscribeHandler, buyProHandler } = require('./payments');
const { historyHandler } = require('./history');
const { reminderHandler } = require('./reminder');
const {
  startHandler,
  helpHandler,
  feedbackHandler,
  cancelAutopayHandler,
  autopayEnableHandler,
  askExpertHandler,
} = require('./commands');

const token = process.env.BOT_TOKEN_DEV;
if (!token) {
  throw new Error('BOT_TOKEN_DEV not set');
}

const dbUrl = process.env.BOT_DATABASE_URL || process.env.DATABASE_URL;
if (!dbUrl) {
  throw new Error('DATABASE_URL not set');
}
const pool = new Pool({
  connectionString: dbUrl,
});
const bot = new Telegraf(token);

async function init() {
  try {
    await bot.telegram.setMyCommands([
      { command: 'start', description: 'Начать работу' },
      { command: 'help', description: 'Помощь' },
      { command: 'history', description: 'История запросов' },
      { command: 'retry', description: 'Повторить диагностику' },
      { command: 'subscribe', description: 'Купить PRO' },
      { command: 'autopay_enable', description: 'Включить автоплатёж' },
      { command: 'cancel_autopay', description: 'Отключить автоплатёж' },
      { command: 'ask_expert', description: 'Задать вопрос эксперту' },
      { command: 'reminder', description: 'Управление напоминаниями' },
      { command: 'feedback', description: 'Оставить отзыв' },
    ]);

    bot.start(async (ctx) => {
      await startHandler(ctx, pool);
      await bot.telegram.setChatMenuButton(ctx.chat.id, { type: 'commands' });
    });

    bot.command('subscribe', async (ctx) => {
      await subscribeHandler(ctx, pool);
    });

    bot.command('help', (ctx) => helpHandler(ctx));

    bot.command('autopay_enable', async (ctx) => {
      await autopayEnableHandler(ctx, pool);
    });

    bot.command('cancel_autopay', async (ctx) => {
      await cancelAutopayHandler(ctx);
    });

    bot.command('history', async (ctx) => historyHandler(ctx, '', pool));

    bot.command('ask_expert', async (ctx) => {
      await askExpertHandler(ctx, pool);
    });

    bot.command('reminder', reminderHandler);

    bot.action(/^remind/, reminderHandler);

    bot.command('feedback', (ctx) => feedbackHandler(ctx, pool));

    bot.on('photo', (ctx) => photoHandler(pool, ctx));

    bot.on('message', messageHandler);

    bot.action(/^proto\|/, async (ctx) => {
      const parts = ctx.callbackQuery.data.split('|');
      if (parts.length < 5) {
        await ctx.answerCbQuery();
        return ctx.reply('Некорректный формат данных.');
      }
      const [, productHashEnc, val, unit, phi] = parts;
      const productHash = decodeURIComponent(productHashEnc);
      const product = getProductName(productHash) || productHash;
      const msg =
        `Препарат: ${product}\n` +
        `Доза: ${val} ${unit}\n` +
        `Срок ожидания (PHI): ${phi} дней`;
      await ctx.answerCbQuery();
      return ctx.reply(msg);
    });

    bot.action('ask_expert', async (ctx) => {
      await ctx.answerCbQuery();
      return ctx.reply('Свяжитесь с экспертом для уточнения протокола.');
    });

    bot.command('retry', (ctx) => {
      const [, id] = ctx.message.text.split(' ');
      if (id) return retryHandler(ctx, id);
      return ctx.reply('Укажите ID фото после команды /retry');
    });

    bot.action(/^retry\|/, async (ctx) => {
      const [, id] = ctx.callbackQuery.data.split('|');
      await ctx.answerCbQuery();
      return retryHandler(ctx, id);
    });

    bot.action(/^history\|/, async (ctx) => {
      const [, cur] = ctx.callbackQuery.data.split('|');
      await ctx.answerCbQuery();
      return historyHandler(ctx, cur || '', pool);
    });

    bot.action(/^info\|/, async (ctx) => {
      const [, id] = ctx.callbackQuery.data.split('|');
      await ctx.answerCbQuery();
      return retryHandler(ctx, id);
    });

    bot.action('buy_pro', async (ctx) => {
      await buyProHandler(ctx, pool);
    });

    await bot.launch();
    console.log('Bot started');
  } catch (err) {
    console.error('Bot initialization failed', err);
    await pool.end();
    process.exit(1);
  }
}

init();

// Gracefully stop bot and close DB connections on termination
async function shutdown() {
  await bot.stop();
  await pool.end();
  process.exit(0);
}

process.once('SIGINT', async () => {
  await shutdown();
});
process.once('SIGTERM', async () => {
  await shutdown();
});

// Prometheus метрики
const client = require('prom-client');
const http = require('http');

client.collectDefaultMetrics(); // собираем базовые метрики

// Запускаем HTTP-сервер на порту 3000 для Prometheus
http.createServer(async (req, res) => {
  if (req.url === '/metrics') {
    res.setHeader('Content-Type', client.register.contentType);
    res.end(await client.register.metrics());
  } else {
    res.statusCode = 404;
    res.end('Not found');
  }
}).listen(3000, () => {
  console.log('Metrics server listening on :3000');
});
