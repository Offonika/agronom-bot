require('dotenv').config();
const { Telegraf } = require('telegraf');
const { Pool } = require('pg');
const {
  photoHandler,
  messageHandler,
  retryHandler,
  getProductName,
  replyFaq,
  handleClarifySelection,
} = require('./diagnosis');
const { subscribeHandler, buyProHandler } = require('./payments');
const { historyHandler } = require('./history');
const { reminderHandler } = require('./reminder');
const {
  startHandler,
  helpHandler,
  feedbackHandler,
  cancelAutopayHandler,
  autopayEnableHandler,
} = require('./commands');
const { msg } = require('./utils');
const { list } = require('./i18n');
const { createDb } = require('../services/db');
const { createCatalog } = require('../services/catalog');
const { createPlanWizard } = require('./flow/plan_wizard');
const { createPlanPickHandler } = require('./callbacks/plan_pick');
const { createPlanTriggerHandler } = require('./callbacks/plan_trigger');
const { createReminderScheduler } = require('./reminders');
const { createPlanCommands } = require('./planCommands');
const { createPlanFlow } = require('./planFlow');

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
bot.catch((err, ctx) => {
  console.error('Bot error', err, ctx?.update);
});
const db = createDb(pool);
const catalog = createCatalog(pool);
const planWizard = createPlanWizard({ bot, db });
const planPickHandler = createPlanPickHandler({ db });
const planTriggerHandler = createPlanTriggerHandler({ db });
const reminderScheduler = createReminderScheduler({ bot, db });
const planFlow = createPlanFlow({ db, catalog, planWizard });
const planCommands = createPlanCommands({ db, planWizard });
const deps = { pool, db, catalog, planWizard, planFlow };

async function init() {
  try {
    await bot.telegram.setMyCommands([
      { command: 'start', description: '🌱 Начать работу' },
      { command: 'help', description: 'ℹ️ Помощь' },
      { command: 'history', description: '📜 История запросов' },
      { command: 'objects', description: '🌿 Объекты' },
      { command: 'plans', description: '🧾 Планы' },
      { command: 'done', description: '✅ Завершить этап' },
      { command: 'skip', description: '⏭ Пропустить этап' },
      { command: 'retry', description: '🔄 Повторить диагностику' },
      { command: 'subscribe', description: '💳 Купить PRO' },
      { command: 'autopay_enable', description: '▶️ Включить автоплатёж' },
      { command: 'cancel_autopay', description: '⛔ Отключить автоплатёж' },
      { command: 'reminder', description: '⏰ Управление напоминаниями' },
      { command: 'feedback', description: '💬 Оставить отзыв' },
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
    bot.command('objects', (ctx) => planCommands.handleObjects(ctx));
    bot.command('use', (ctx) => planCommands.handleUse(ctx));
    bot.command('plans', (ctx) => planCommands.handlePlans(ctx));
    bot.command('plan', (ctx) => planCommands.handlePlan(ctx));
    bot.command('done', (ctx) => planCommands.handleDone(ctx));
    bot.command('skip', (ctx) => planCommands.handleSkip(ctx));

    bot.command('reminder', reminderHandler);

    bot.action(/^remind/, reminderHandler);

    bot.command('feedback', (ctx) => feedbackHandler(ctx, pool));

    bot.on('photo', (ctx) => photoHandler(deps, ctx));

    bot.on('message', messageHandler);

    bot.action(/^pick_opt\|/, planPickHandler);
    bot.action(/^plan_obj_confirm\|/, async (ctx) => {
      const [, objectId] = ctx.callbackQuery.data.split('|');
      await planFlow.confirm(ctx, Number(objectId));
    });
    bot.action('plan_obj_choose', (ctx) => planFlow.choose(ctx));
    bot.action(/^plan_obj_pick\|/, async (ctx) => {
      const [, objectId] = ctx.callbackQuery.data.split('|');
      await planFlow.pick(ctx, Number(objectId));
    });
    bot.action('plan_obj_create', (ctx) => planFlow.create(ctx));
    bot.action(/^plan_trigger\|/, planTriggerHandler);

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

    bot.command('retry', (ctx) => {
      const [, id] = ctx.message.text.split(' ');
      if (id) return retryHandler(deps, ctx, id);
      return ctx.reply('Укажите ID фото после команды /retry');
    });

    bot.action(/^retry\|/, async (ctx) => {
      const [, id] = ctx.callbackQuery.data.split('|');
      await ctx.answerCbQuery();
      return retryHandler(deps, ctx, id);
    });

    bot.action(/^history\|/, async (ctx) => {
      const [, cur] = ctx.callbackQuery.data.split('|');
      await ctx.answerCbQuery();
      return historyHandler(ctx, cur || '', pool);
    });

    bot.action(/^info\|/, async (ctx) => {
      const [, id] = ctx.callbackQuery.data.split('|');
      await ctx.answerCbQuery();
      return retryHandler(ctx, id, pool);
    });

    bot.action('plan_treatment', async (ctx) => {
      await ctx.answerCbQuery();
      return ctx.reply(msg('plan_action_hint'));
    });

    bot.action('phi_reminder', async (ctx) => {
      await ctx.answerCbQuery();
      return ctx.reply(msg('phi_action_hint'));
    });

    bot.action('pdf_note', async (ctx) => {
      await ctx.answerCbQuery();
      return ctx.reply(msg('pdf_action_hint'));
    });

    bot.action('ask_products', async (ctx) => {
      await ctx.answerCbQuery();
      await replyFaq(ctx, 'regional_products');
    });

    bot.action('reshoot_photo', async (ctx) => {
      await ctx.answerCbQuery();
      const tips = list('reshoot.tips').map((tip) => `• ${tip}`).join('\n');
      const text = [msg('reshoot.action'), tips].filter(Boolean).join('\n');
      return ctx.reply(text);
    });

    bot.action(/^faq\|/, async (ctx) => {
      const [, intent] = ctx.callbackQuery.data.split('|');
      await ctx.answerCbQuery();
      await replyFaq(ctx, intent);
    });

    bot.action(/^clarify_crop\|/, async (ctx) => {
      const [, optionId] = ctx.callbackQuery.data.split('|');
      await handleClarifySelection(ctx, optionId);
    });

    bot.action('buy_pro', async (ctx) => {
      await buyProHandler(ctx, pool);
    });

    await bot.launch();
    reminderScheduler.start();
    console.log('Bot started');
  } catch (err) {
    console.error('Bot initialization failed', err);
    await pool.end();
    process.exit(1);
  }
}

init();

// Gracefully stop bot and close DB connections on termination
let metricsServer;
async function shutdown() {
  reminderScheduler.stop();
  await bot.stop();
  if (metricsServer) {
    try {
      await new Promise((resolve, reject) =>
        metricsServer.close((err) => (err ? reject(err) : resolve())),
      );
    } catch (err) {
      console.error('Metrics server close failed', err);
    }
  }
  try {
    await pool.end();
  } catch (err) {
    console.error('DB pool close failed', err);
  }
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

const metricsPortRaw =
  process.env.BOT_METRICS_PORT || process.env.METRICS_PORT || '3000';
const metricsPort = Number(metricsPortRaw);

if (Number.isNaN(metricsPort) || metricsPort <= 0) {
  console.warn(
    `Prometheus metrics server disabled: invalid BOT_METRICS_PORT="${metricsPortRaw}"`,
  );
} else {
  metricsServer = http.createServer(async (req, res) => {
    if (req.url === '/metrics') {
      res.setHeader('Content-Type', client.register.contentType);
      res.end(await client.register.metrics());
    } else {
      res.statusCode = 404;
      res.end('Not found');
    }
  });

  metricsServer.once('error', (err) => {
    console.error(
      `Metrics server failed to bind on :${metricsPort}. Set BOT_METRICS_PORT to a free port to enable metrics.`,
      err,
    );
    metricsServer = null;
  });

  metricsServer.listen(metricsPort, () => {
    console.log(`Metrics server listening on :${metricsPort}`);
  });
}
