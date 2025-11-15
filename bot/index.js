require('dotenv').config();
const { Telegraf } = require('telegraf');
const { Queue } = require('bullmq');
const { Pool } = require('pg');
const {
  photoHandler,
  messageHandler,
  retryHandler,
  getProductName,
  replyFaq,
  handleClarifySelection,
  getLastDiagnosis,
  rememberDiagnosis,
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
  newDiagnosisHandler,
} = require('./commands');
const { msg } = require('./utils');
const { list } = require('./i18n');
const { createDb } = require('../services/db');
const { createCatalog } = require('../services/catalog');
const { createPlanWizard } = require('./flow/plan_wizard');
const { createPlanPickHandler } = require('./callbacks/plan_pick');
const { createPlanTriggerHandler } = require('./callbacks/plan_trigger');
const { createPlanManualSlotHandlers } = require('./callbacks/plan_manual_slot');
const { createPlanSlotHandlers } = require('./callbacks/plan_slot');
const { createReminderScheduler } = require('./reminders');
const { createPlanCommands } = require('./planCommands');
const { createPlanFlow } = require('./planFlow');
const { createObjectChips } = require('./objectChips');
const { LOW_CONFIDENCE_THRESHOLD } = require('./messageFormatters/diagnosisMessage');
const { replyUserError } = require('./userErrors');
const { logFunnelEvent } = require('./funnel');

const { formatSlotCard, buildSlotKeyboard } = require('../services/slot_card');

const HOUR_IN_MS = 60 * 60 * 1000;

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
const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
const autoplanQueue = new Queue('autoplan', {
  connection: { url: redisUrl },
});
const rawHandlerTimeout = process.env.BOT_HANDLER_TIMEOUT_MS;
let handlerTimeoutMs = Number(rawHandlerTimeout);
if (!Number.isFinite(handlerTimeoutMs)) {
  handlerTimeoutMs = 180000;
} else if (handlerTimeoutMs <= 0) {
  handlerTimeoutMs = Number.POSITIVE_INFINITY;
}
const bot = new Telegraf(token, { handlerTimeout: handlerTimeoutMs });
bot.catch((err, ctx) => {
  console.error('Bot error', err, ctx?.update);
});
const db = createDb(pool);
const catalog = createCatalog(pool);
const reminderScheduler = createReminderScheduler({ bot, db });
const planWizard = createPlanWizard({ bot, db });
const planManualHandlers = createPlanManualSlotHandlers({ db, reminderScheduler });
const planPickHandler = createPlanPickHandler({
  db,
  reminderScheduler,
  autoplanQueue,
  manualSlots: planManualHandlers,
});
const planTriggerHandler = createPlanTriggerHandler({ db, reminderScheduler });
const planFlow = createPlanFlow({ db, catalog, planWizard });
const objectChips = createObjectChips({ bot, db, planFlow });
const planCommands = createPlanCommands({ db, planWizard, objectChips });
const planSlotHandlers = createPlanSlotHandlers({ db, reminderScheduler, autoplanQueue });
const deps = { pool, db, catalog, planWizard, planFlow, objectChips };
const planOnboardingShown = new Set();

function toDate(value) {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function isRecentDiagnosisExpired(record) {
  const expiresAt = toDate(record?.expires_at);
  if (!expiresAt) return false;
  return expiresAt.getTime() < Date.now();
}

function describeRecentAge(record) {
  const created = toDate(record?.created_at);
  if (!created) return msg('plan_recent_age_unknown');
  const diffMs = Math.max(0, Date.now() - created.getTime());
  const hours = Math.round(diffMs / HOUR_IN_MS) || 1;
  if (hours < 24) {
    return msg('plan_recent_age_hours', { hours });
  }
  const days = Math.max(1, Math.round(hours / 24));
  return msg('plan_recent_age_days', { days });
}

function buildStaleRecordKeyboard(record) {
  const diagnosisId = record?.id;
  if (!diagnosisId) return undefined;
  return {
    inline_keyboard: [
      [{ text: msg('plan_recent_use_button'), callback_data: `plan_recent_use|${diagnosisId}` }],
      [{ text: msg('plan_recent_new_photo_button'), callback_data: 'plan_recent_new' }],
    ],
  };
}

function buildExistingPlanKeyboard(record) {
  const planId = record?.plan_id;
  const diagnosisId = record?.id;
  const rows = [];
  if (planId) {
    rows.push([{ text: msg('plan_recent_open_button'), callback_data: `plan_recent_open|${planId}` }]);
  }
  if (diagnosisId) {
    rows.push([
      {
        text: msg('plan_recent_new_plan_button'),
        callback_data: `plan_recent_force|${diagnosisId}`,
      },
    ]);
  }
  return rows.length ? { inline_keyboard: rows } : undefined;
}

async function resolveDiagnosisForPlanning(userId, opts = {}) {
  if (!userId) return { diagnosis: null, record: null, expired: false, source: null };
  const requiredId = opts.requireRecentId ? Number(opts.requireRecentId) : null;
  if (!requiredId) {
    const cached = getLastDiagnosis(userId);
    if (cached) {
      return { diagnosis: cached, record: null, expired: false, source: 'memory' };
    }
  } else {
    const cached = getLastDiagnosis(userId);
    if (cached?.recent_diagnosis_id === requiredId) {
      return { diagnosis: cached, record: null, expired: false, source: 'memory' };
    }
  }
  if (!db?.getLatestRecentDiagnosis) {
    return { diagnosis: null, record: null, expired: false, source: null };
  }
  try {
    const record = requiredId
      ? await db.getRecentDiagnosisById(userId, requiredId)
      : await db.getLatestRecentDiagnosis(userId);
    if (!record?.diagnosis_payload) {
      return { diagnosis: null, record: null, expired: false, source: null };
    }
    const payload = record.diagnosis_payload;
    payload.recent_diagnosis_id = record.id;
    rememberDiagnosis(userId, payload);
    return {
      diagnosis: payload,
      record,
      expired: isRecentDiagnosisExpired(record),
      source: 'recent',
    };
  } catch (err) {
    console.error('recent_diagnosis fetch failed', err);
    return { diagnosis: null, record: null, expired: false, source: null };
  }
}

function maybeSendPlanOnboarding(ctx) {
  const userId = ctx.from?.id;
  if (!userId || planOnboardingShown.has(userId)) return;
  planOnboardingShown.add(userId);
  ctx.reply(msg('plan_onboarding_steps'), {
    reply_markup: {
      inline_keyboard: [[{ text: msg('plan_onboarding_demo_button'), callback_data: 'plan_demo' }]],
    },
  });
}

async function handlePlanTreatment(ctx, opts = {}) {
  const userId = ctx.from?.id;
  if (!userId) return;
  maybeSendPlanOnboarding(ctx);
  const pendingTime =
    typeof db.getLatestTimeSessionForUser === 'function'
      ? await db.getLatestTimeSessionForUser(userId)
      : null;
  if (pendingTime && (pendingTime.current_step || '').startsWith('time_')) {
    const resumed = await resumePlanTimeSession(ctx, pendingTime);
    if (resumed) return;
  }
  const requireRecentId = opts.requireRecentId ? Number(opts.requireRecentId) : null;
  const context = await resolveDiagnosisForPlanning(userId, {
    requireRecentId,
    latestOnly: opts.retryLatest,
  });
  const diagnosis = context.diagnosis;
  const record = context.record;
  if (!diagnosis) {
    if (requireRecentId) {
      await replyUserError(ctx, 'BUTTON_EXPIRED');
    } else {
      await replyUserError(ctx, 'NO_RECENT_DIAGNOSIS');
    }
    return;
  }
  const expired = context.expired;
  const hasPlan = Boolean(record?.plan_id);
  console.info('plan_treatment.context', {
    userId,
    source: context.source || 'memory',
    requireRecentId,
    expired,
    planId: record?.plan_id || null,
  });
  if (hasPlan && !opts.allowExistingPlan) {
    await ctx.reply(msg('plan_recent_existing', { plan: record.plan_id }), {
      reply_markup: buildExistingPlanKeyboard(record),
    });
    return;
  }
  if (expired && !opts.allowExpired) {
    await ctx.reply(msg('plan_recent_stale', { age: describeRecentAge(record) }), {
      reply_markup: buildStaleRecordKeyboard(record),
    });
    return;
  }
  if ((diagnosis.confidence ?? 0) < LOW_CONFIDENCE_THRESHOLD) {
    await replyUserError(ctx, 'LOW_CONFIDENCE');
    return;
  }
  let dbUser = null;
  if (typeof db.ensureUser === 'function') {
    try {
      dbUser = await db.ensureUser(userId);
    } catch (err) {
      console.error('plan_treatment.ensure_user_failed', err);
    }
  }
  if (dbUser) {
    await logFunnelEvent(db, {
      event: 'plan_treatment_clicked',
      userId: dbUser.id,
      objectId: dbUser.last_object_id || null,
      planId: record?.plan_id || null,
      data: {
        recentId: record?.id || null,
        expired: Boolean(context.expired),
        source: context.source || null,
      },
    });
  }
  try {
    await planFlow.start(ctx, diagnosis);
  } catch (err) {
    console.error('plan_treatment action error', err);
    await ctx.reply(msg('plan_object_error'));
  }
}

async function resumePlanTimeSession(ctx, session) {
  if (!session) return false;
  const state = session.state || {};
  const step = session.current_step || state.mode || '';
  try {
    switch (step) {
      case 'time_manual_prompt': {
        const stageId = state.stageId;
        if (!stageId || typeof db.getStageById !== 'function') {
          await db.deletePlanSession(session.id);
          return false;
        }
        const stage = await db.getStageById(stageId);
        if (!stage) {
          await db.deletePlanSession(session.id);
          return false;
        }
        const sent = await planManualHandlers.prompt(ctx, {
          stage,
          optionId: state.stageOptionId || null,
        });
        if (sent && typeof db.updatePlanSession === 'function') {
          await db.updatePlanSession(session.id, { ttlHours: 72 });
        }
        return Boolean(sent);
      }
      case 'time_autoplan_lookup': {
        await ctx.reply(msg('plan_autoplan_lookup'));
        if (typeof db.updatePlanSession === 'function') {
          await db.updatePlanSession(session.id, { ttlHours: 72 });
        }
        return true;
      }
      case 'time_autoplan_slot': {
        const slotId = state.slotId;
        if (!slotId || typeof db.getTreatmentSlotContext !== 'function') {
          await db.deletePlanSession(session.id);
          return false;
        }
        const slotContext = await db.getTreatmentSlotContext(slotId);
        if (!slotContext) {
          await db.deletePlanSession(session.id);
          return false;
        }
        await sendSlotCardMessage(ctx, slotContext);
        if (typeof db.updatePlanSession === 'function') {
          await db.updatePlanSession(session.id, { ttlHours: 72 });
        }
        return true;
      }
      case 'time_wait_trigger': {
        await ctx.reply(msg('plan_saved_wait_trigger'));
        await db.deletePlanSession(session.id);
        return true;
      }
      case 'time_scheduled': {
        await ctx.reply(msg('plan_saved_toast'));
        await db.deletePlanSession(session.id);
        return true;
      }
      default:
        return false;
    }
  } catch (err) {
    console.error('plan_time.resume error', err);
    try {
      await db.deletePlanSession(session.id);
    } catch {
      // ignore
    }
    return false;
  }
}

async function sendSlotCardMessage(ctx, slotContext) {
  if (!ctx?.reply || !slotContext?.slot) return false;
  const slot = normalizeSlot(slotContext.slot);
  const text = formatSlotCard({
    slot,
    stageName: slotContext.stage?.title,
    objectName: slotContext.object?.name,
    translate: msg,
  });
  const markup = buildSlotKeyboard(slot.id, msg);
  await ctx.reply(text, { reply_markup: markup });
  return true;
}

function normalizeSlot(rawSlot) {
  if (!rawSlot) return null;
  const start = rawSlot.slot_start instanceof Date ? rawSlot.slot_start : new Date(rawSlot.slot_start);
  const end = rawSlot.slot_end instanceof Date ? rawSlot.slot_end : new Date(rawSlot.slot_end);
  return {
    id: rawSlot.id,
    start,
    end,
    reason: Array.isArray(rawSlot.reason) ? rawSlot.reason : rawSlot.reason ? [rawSlot.reason] : [],
  };
}

async function init() {
  try {
    await bot.telegram.setMyCommands([
      { command: 'new', description: '📷 Новый диагноз' },
      { command: 'plans', description: '📋 Мои планы' },
      { command: 'objects', description: '🌱 Мои растения' },
    ]);

    bot.start(async (ctx) => {
      await startHandler(ctx, pool);
      await bot.telegram.setChatMenuButton(ctx.chat.id, { type: 'commands' });
    });

    bot.command('subscribe', async (ctx) => {
      await subscribeHandler(ctx, pool);
    });

    bot.command('new', async (ctx) => newDiagnosisHandler(ctx));

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
    bot.command('stats', (ctx) => planCommands.handleStats(ctx));
    bot.command('demo', async (ctx) => {
      await ctx.reply(msg('plan_demo_public_intro'));
      await ctx.reply(msg('plan_demo_public_table'));
      await ctx.reply(msg('plan_demo_public_note'));
    });

    bot.command('reminder', reminderHandler);

    bot.action(/^remind/, reminderHandler);

    bot.command('feedback', (ctx) => feedbackHandler(ctx, pool));

    bot.on('photo', (ctx) => photoHandler(deps, ctx));

    bot.on('message', messageHandler);

    bot.action(/^pick_opt\|/, planPickHandler);
    bot.action(/^plan_slot_accept\|/, planSlotHandlers.accept);
    bot.action(/^plan_slot_cancel\|/, planSlotHandlers.cancel);
    bot.action(/^plan_slot_reschedule\|/, planSlotHandlers.reschedule);
    bot.action(/^plan_manual_slot\|/, planManualHandlers.confirm);
    bot.action(/^plan_manual_pick\|/, planManualHandlers.pick);
    bot.action(/^plan_obj_confirm\|/, async (ctx) => {
      const [, objectId, token] = ctx.callbackQuery.data.split('|');
      await planFlow.confirm(ctx, objectId, token || null);
    });
    bot.action(/^plan_obj_choose/, (ctx) => {
      const [, token] = ctx.callbackQuery.data.split('|');
      return planFlow.choose(ctx, token || null);
    });
    bot.action(/^plan_obj_pick\|/, async (ctx) => {
      const [, objectId, token] = ctx.callbackQuery.data.split('|');
      await planFlow.pick(ctx, objectId, token || null);
    });
    bot.action(/^plan_obj_create/, (ctx) => {
      const [, token] = ctx.callbackQuery.data.split('|');
      return planFlow.create(ctx, token || null);
    });
    bot.action(/^plan_trigger\|/, planTriggerHandler.prompt);
    bot.action(/^plan_trigger_at\|/, planTriggerHandler.confirm);
    bot.action(/^obj_switch\|/, async (ctx) => {
      const [, objectId] = ctx.callbackQuery.data.split('|');
      await objectChips.handleSwitch(ctx, objectId);
    });

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
      await handlePlanTreatment(ctx);
    });

    bot.action(/^plan_recent_use\|/, async (ctx) => {
      const [, diagnosisId] = ctx.callbackQuery.data.split('|');
      await ctx.answerCbQuery();
      await handlePlanTreatment(ctx, {
        requireRecentId: diagnosisId,
        allowExpired: true,
        allowExistingPlan: true,
      });
    });

    bot.action('plan_recent_new', async (ctx) => {
      await ctx.answerCbQuery();
      await handlePlanTreatment(ctx, {
        allowExpired: true,
        allowExistingPlan: true,
        retryLatest: true,
      });
    });

    bot.action(/^plan_recent_force\|/, async (ctx) => {
      const [, diagnosisId] = ctx.callbackQuery.data.split('|');
      await ctx.answerCbQuery();
      await handlePlanTreatment(ctx, {
        requireRecentId: diagnosisId,
        allowExpired: true,
        allowExistingPlan: true,
      });
    });

    bot.action(/^plan_recent_open\|/, async (ctx) => {
      const [, planIdRaw] = ctx.callbackQuery.data.split('|');
      await ctx.answerCbQuery();
      const planId = Number(planIdRaw);
      if (!planId) {
        await replyUserError(ctx, 'PLAN_NOT_FOUND');
        return;
      }
      try {
        const user = await db.ensureUser(ctx.from.id);
        const plan = await db.getPlanForUser(planId, user.id);
        if (!plan) {
          await replyUserError(ctx, 'PLAN_NOT_FOUND');
          return;
        }
        await ctx.reply(msg('plan_show_intro', { title: plan.title }));
        await planWizard.showPlanTable(ctx.chat.id, plan.id, {
          userId: user.id,
          diffAgainst: 'accepted',
        });
      } catch (err) {
        console.error('plan_recent_open error', err);
        await ctx.reply(msg('plan_error'));
      }
    });

    bot.action('plan_error_objects', async (ctx) => {
      await ctx.answerCbQuery();
      await planCommands.handleObjects(ctx);
    });

    bot.action('plan_error_plans', async (ctx) => {
      await ctx.answerCbQuery();
      await planCommands.handlePlans(ctx);
    });

    bot.action(/^plan_event\|/, async (ctx) => {
      const [, action, value] = ctx.callbackQuery.data.split('|');
      await ctx.answerCbQuery();
      await planCommands.handleEventAction(ctx, action, value);
    });

    bot.action('plan_demo', async (ctx) => {
      await ctx.answerCbQuery();
      const demoBlocks = [
        msg('plan_demo_photo'),
        msg('plan_demo_plan_table'),
        msg('plan_demo_time'),
        msg('plan_demo_cancel_hint'),
      ];
      for (const block of demoBlocks) {
        if (block) {
          await ctx.reply(block);
        }
      }
      await ctx.reply(msg('plan_demo_ready'), {
        reply_markup: {
          inline_keyboard: [[{ text: msg('plan_demo_close_button'), callback_data: 'plan_demo_close' }]],
        },
      });
    });

    bot.action('plan_demo_close', async (ctx) => {
      await ctx.answerCbQuery(msg('plan_demo_close_toast'));
    });

    bot.action(/^plan_step_cancel\|/, async (ctx) => {
      const [, token] = ctx.callbackQuery.data.split('|');
      await ctx.answerCbQuery();
      if (token && typeof db.getPlanSessionByToken === 'function' && typeof db.deletePlanSession === 'function') {
        try {
          const session = await db.getPlanSessionByToken(token);
          if (session) {
            await db.deletePlanSession(session.id);
          }
        } catch (err) {
          console.error('plan_step_cancel cleanup failed', err);
        }
      }
      await ctx.reply(msg('plan_step_cancelled'));
    });

    bot.action(/^plan_step_back\|/, async (ctx) => {
      const [, token] = ctx.callbackQuery.data.split('|');
      await ctx.answerCbQuery();
      if (!token || typeof db.getPlanSessionByToken !== 'function') {
        await replyUserError(ctx, 'BUTTON_EXPIRED');
        return;
      }
      try {
        const session = await db.getPlanSessionByToken(token);
        if (!session) {
          await replyUserError(ctx, 'BUTTON_EXPIRED');
          return;
        }
        if (typeof db.deletePlanSession === 'function') {
          await db.deletePlanSession(session.id);
        }
        await planFlow.start(ctx, session.diagnosis_payload);
      } catch (err) {
        console.error('plan_step_back error', err);
        await replyUserError(ctx, 'BUTTON_EXPIRED');
      }
    });

    bot.action(/^plan_chips_select\|/, async (ctx) => {
      const [, objectId] = ctx.callbackQuery.data.split('|');
      await ctx.answerCbQuery();
      if (!objectId) {
        await replyUserError(ctx, 'BUTTON_EXPIRED');
        return;
      }
      const userId = ctx.from?.id;
      if (!userId) {
        await replyUserError(ctx, 'NO_RECENT_DIAGNOSIS');
        return;
      }
      await planFlow.confirm(ctx, objectId, null);
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
    await reminderScheduler.start();
    console.log('Bot started');
  } catch (err) {
    console.error('Bot initialization failed', err);
    await pool.end();
    await autoplanQueue.close();
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
  try {
    await autoplanQueue.close();
  } catch (err) {
    console.error('Autoplan queue close failed', err);
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
