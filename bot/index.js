require('dotenv').config();
const { Telegraf } = require('telegraf');
const { Queue } = require('bullmq');
const Redis = require('ioredis');
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
const { createPlanLocationHandler } = require('./callbacks/plan_location');
const { createPlanManualSlotHandlers } = require('./callbacks/plan_manual_slot');
const { createPlanSlotHandlers } = require('./callbacks/plan_slot');
const { createReminderScheduler } = require('./reminders');
const { createOverdueNotifier } = require('./overdueNotifier');
const { createPlanCommands } = require('./planCommands');
const { createPlanFlow } = require('./planFlow');
const { createPlanSessionsApi } = require('./planSessionsApi');
const { createObjectChips } = require('./objectChips');
const { LOW_CONFIDENCE_THRESHOLD } = require('./messageFormatters/diagnosisMessage');
const { replyUserError } = require('./userErrors');
const { logFunnelEvent } = require('./funnel');
const photoTips = require('./photoTips');
const {
  addPhoto,
  getState: getPhotoState,
  pickPrimary: pickPhotoForAnalysis,
  clearSession: clearPhotoSession,
  skipOptional: skipOptionalPhotos,
  MIN_PHOTOS,
  MAX_PHOTOS,
} = require('./photoCollector');
const { analyzePhoto } = require('./diagnosis');

const { formatSlotCard, buildSlotKeyboard } = require('../services/slot_card');
const { createGeocoder } = require('../services/geocoder');

const HOUR_IN_MS = 60 * 60 * 1000;
const PLAN_START_THROTTLE_MS = 2000;
const planStartGuards = new Map();
const photoReplyTimers = new Map();
const photoLastStatus = new Map();

function formatPercent(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) return null;
  return Math.round(Math.max(0, Math.min(1, value)) * 100);
}

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
const redis = new Redis(redisUrl);
redis.on('error', (err) => {
  console.error('Redis error', err);
});
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
const overdueNotifier = createOverdueNotifier({ bot, db });
const planWizard = createPlanWizard({ bot, db });
const geocoder = createGeocoder({ redis });
const planManualHandlers = createPlanManualSlotHandlers({ db, reminderScheduler });
const planPickHandler = createPlanPickHandler({
  db,
  reminderScheduler,
  autoplanQueue,
  manualSlots: planManualHandlers,
});
const planTriggerHandler = createPlanTriggerHandler({ db, reminderScheduler });
const planSessionsApi = createPlanSessionsApi();
const planFlow = createPlanFlow({ db, catalog, planWizard, geocoder, planSessions: planSessionsApi });
const objectChips = createObjectChips({ bot, db, planFlow });
const pendingObjectDetails = new Map();
const DETAILS_PROMPT_TTL_MS = Number(process.env.OBJECT_DETAILS_PROMPT_TTL_MS || `${24 * 60 * 60 * 1000}`);
if (typeof planFlow.attachObjectChips === 'function') {
  planFlow.attachObjectChips(objectChips);
}
planFlow.watch(async (event) => {
  if (event?.type !== 'plan_created' || !event.chatId) return;
  try {
    await bot.telegram.sendMessage(event.chatId, msg('plans_manage_hint'), {
      reply_markup: {
        inline_keyboard: [[{ text: msg('plans_manage_button'), callback_data: 'plan_my_plans' }]],
      },
    });
    if (event.objectId && event.userId) {
      await maybePromptObjectDetails(event.objectId, event.userId, event.chatId);
      await maybeSuggestMerge(event.objectId, event.userId, event.chatId);
    }
  } catch (err) {
    console.error('plan_my_plans notify failed', err);
  }
});
const planCommands = createPlanCommands({ db, planWizard, objectChips, geocoder, planFlow });
const planSlotHandlers = createPlanSlotHandlers({ db, reminderScheduler, autoplanQueue });
const planLocationHandler = createPlanLocationHandler({ db });
const deps = { pool, db, catalog, planWizard, planFlow, objectChips };
const planOnboardingShown = new Set();
const planShortHintShown = new Map();

const PHOTO_LABEL_KEYS = [
  'photo_album_label_overview',
  'photo_album_label_front',
  'photo_album_label_back',
  'photo_album_label_fruit',
  'photo_album_label_root',
];

function now() {
  return Date.now();
}

async function getObjectSafe(objectId) {
  if (!objectId || typeof db.getObjectById !== 'function') return null;
  try {
    return await db.getObjectById(objectId);
  } catch (err) {
    console.error('object fetch failed', err);
    return null;
  }
}

async function maybePromptObjectDetails(objectId, userId, chatId) {
  const object = await getObjectSafe(objectId);
  if (!object || Number(object.user_id) !== Number(userId)) return;
  const meta = object.meta || {};
  const missingVariety = !meta.variety;
  const missingNote = !meta.note;
  if (!missingVariety && !missingNote) return;
  const promptedAt =
    meta.details_prompted_at instanceof Date
      ? meta.details_prompted_at.getTime()
      : meta.details_prompted_at
      ? new Date(meta.details_prompted_at).getTime()
      : 0;
  if (promptedAt && now() - promptedAt < DETAILS_PROMPT_TTL_MS) return;
  const rows = [];
  if (missingVariety) {
    rows.push([{ text: msg('object_details_button_variety'), callback_data: `obj_detail|variety|${object.id}` }]);
  }
  if (missingNote) {
    rows.push([{ text: msg('object_details_button_note'), callback_data: `obj_detail|note|${object.id}` }]);
  }
  rows.push([{ text: msg('object_details_skip'), callback_data: `obj_detail_skip|${object.id}` }]);
  await bot.telegram.sendMessage(chatId, msg('object_details_intro', { name: object.name }), {
    reply_markup: { inline_keyboard: rows },
  });
  if (typeof db.updateObjectMeta === 'function') {
    await db.updateObjectMeta(object.id, { details_prompted_at: new Date().toISOString() });
  }
}

async function maybeSuggestMerge(objectId, userId, chatId) {
  if (!objectId || !userId || typeof db.listObjects !== 'function') return;
  try {
    const objects = await db.listObjects(userId);
    const current = objects.find((o) => Number(o.id) === Number(objectId));
    if (!current) return;
    const similar = objects.filter(
      (o) => Number(o.id) !== Number(objectId) && (o.type === current.type || o.name === current.name),
    );
    if (similar.length < 1) return;
    const candidates = [current, ...similar].sort((a, b) => Number(a.id) - Number(b.id));
    const target = candidates[0];
    const merges = candidates.slice(1).map((s) => ({
      source: s.id,
      target: target.id,
      label: formatObjectLabel(s),
    }));
    const names = candidates.map((o) => formatObjectLabel(o)).join(', ');
    const inline_keyboard = merges.map((m) => [
      {
        text: msg('objects_merge_button', { source: m.source, target: m.target }),
        callback_data: `obj_merge|${m.source}|${m.target}`,
      },
    ]);
    await bot.telegram.sendMessage(chatId, msg('objects_merge_suggest', { names }), {
      reply_markup: { inline_keyboard },
    });
  } catch (err) {
    console.error('merge suggest failed', err);
  }
}

function setDetailsSession(userId, objectId, field) {
  pendingObjectDetails.set(userId, { objectId, field, createdAt: now() });
}

function clearDetailsSession(userId) {
  pendingObjectDetails.delete(userId);
}

async function handleObjectDetailsText(ctx) {
  const userId = ctx.from?.id;
  const text = ctx.message?.text?.trim();
  if (!userId || !text) return false;
  const session = pendingObjectDetails.get(userId);
  if (!session) return false;
  if (text.startsWith('/')) return false;
  let object = await getObjectSafe(session.objectId);
  if (!object || Number(object.user_id) !== Number(userId)) {
    const user = await db.ensureUser(userId);
    const list = (await db.listObjects(user.id)) || [];
    const fallback =
      list.find((o) => Number(o.id) === Number(user.last_object_id)) ||
      list.find((o) => Number(o.id) !== Number(session.objectId)) ||
      list[0];
    if (!fallback) {
      clearDetailsSession(userId);
      await ctx.reply(msg('objects_not_found'));
      return true;
    }
    object = fallback;
  }
  const patch =
    session.field === 'variety'
      ? { variety: text, details_prompted_at: new Date().toISOString() }
      : { note: text, details_prompted_at: new Date().toISOString() };
  if (typeof db.updateObjectMeta === 'function') {
    await db.updateObjectMeta(object.id, patch);
  }
  clearDetailsSession(userId);
  const key = session.field === 'variety' ? 'object_details_saved_variety' : 'object_details_saved_note';
  await ctx.reply(msg(key, { value: text }));
  if (objectChips) {
    await objectChips.send(ctx);
  }
  return true;
}

function buildPhotoStatusPayload(state) {
  if (!state) return null;
  const checklist = buildPhotoChecklist(state.count || 0);
  const parts = [
    msg('photo_album_status', { count: state.count || 0, min: MIN_PHOTOS, max: MAX_PHOTOS }),
  ];
  if (state.overflow) {
    parts.push(msg('photo_album_overflow', { max: MAX_PHOTOS }));
  }
  if (checklist) {
    parts.push(msg('photo_album_checklist', { checklist }));
  }
  if (!state.optionalSkipped) {
    parts.push(msg('photo_album_optional'));
  }
  if (state.ready) {
    parts.push(msg('photo_album_ready', { max: MAX_PHOTOS }));
  } else {
    const need = Math.max(0, MIN_PHOTOS - (state.count || 0));
    parts.push(msg('photo_album_not_ready', { need }));
  }
  const text = parts.filter(Boolean).join('\n');
  return {
    text,
    reply_markup: buildPhotoKeyboard(state.ready, state.optionalSkipped, (state.count || 0) < MAX_PHOTOS),
  };
}

function schedulePhotoStatus(ctx) {
  const userId = ctx.from?.id;
  const chatId = ctx.chat?.id;
  if (!userId || !chatId) return;
  if (photoReplyTimers.has(userId)) {
    clearTimeout(photoReplyTimers.get(userId));
  }
  const timer = setTimeout(async () => {
    photoReplyTimers.delete(userId);
    try {
      const state = getPhotoState(userId);
      const payload = buildPhotoStatusPayload(state);
      if (!payload?.text) return;
      const last = photoLastStatus.get(userId);
      if (last === payload.text) return;
      photoLastStatus.set(userId, payload.text);
      await ctx.telegram.sendMessage(chatId, payload.text, {
        reply_markup: payload.reply_markup,
        reply_to_message_id: undefined,
        allow_sending_without_reply: true,
      });
    } catch (err) {
      console.error('photo_status_send_failed', err);
    }
  }, 500);
  photoReplyTimers.set(userId, timer);
}

function toDate(value) {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function buildPhotoChecklist(count) {
  const rows = [];
  for (let i = 0; i < PHOTO_LABEL_KEYS.length; i += 1) {
    const label = msg(PHOTO_LABEL_KEYS[i]);
    if (!label) continue;
    const status = count > i ? msg('photo_album_status_ready') || '✓' : msg('photo_album_status_missing') || '✗';
    rows.push(msg('photo_album_check_item', { label, status }) || `${label}: ${status}`);
  }
  return rows.join('\n');
}

function buildPhotoKeyboard(ready, optionalSkipped, canAddMore) {
  const doneText = msg('photo_album_button_done');
  const resetText = msg('photo_album_button_reset');
  const addText = msg('photo_album_button_add');
  const skipText = msg('photo_album_button_skip_optional');
  const rows = [];
  if (ready && doneText) {
    rows.push([{ text: doneText, callback_data: 'photo_album_done' }]);
  }
  if (addText && canAddMore) {
    rows.push([{ text: addText, callback_data: 'photo_album_add' }]);
  }
  if (skipText && !optionalSkipped) {
    rows.push([{ text: skipText, callback_data: 'photo_album_skip_optional' }]);
  }
  if (resetText) {
    rows.push([{ text: resetText, callback_data: 'photo_album_reset' }]);
  }
  return { inline_keyboard: rows };
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

function buildPlanDedupKey(diagnosis, record) {
  if (!diagnosis && !record) return null;
  return (
    diagnosis?.recent_diagnosis_id ||
    record?.id ||
    diagnosis?.plan_hash ||
    [diagnosis?.crop, diagnosis?.disease, diagnosis?.confidence].map((v) => String(v ?? '')).join('|')
  );
}

function isPlanStartDuplicate(userId, key) {
  if (!userId || !key) return false;
  const state = planStartGuards.get(userId);
  if (!state) return false;
  return state.key === key && Date.now() - state.ts < PLAN_START_THROTTLE_MS;
}

function markPlanStart(userId, key) {
  if (!userId || !key) return;
  planStartGuards.set(userId, { key, ts: Date.now() });
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
      inline_keyboard: [
        [{ text: msg('plan_onboarding_demo_button'), callback_data: 'plan_demo' }],
        [{ text: msg('plan_onboarding_example_button'), callback_data: 'plan_demo_public' }],
      ],
    },
  });
}

async function maybeSendShortPathHint(ctx, diagnosis, record, dbUser) {
  const userId = ctx.from?.id;
  if (!userId || !diagnosis || !dbUser?.id) return;
  const diagId = diagnosis.recent_diagnosis_id || record?.id || null;
  if (diagId && planShortHintShown.get(dbUser.id) === diagId) return;
  if ((diagnosis.confidence ?? 0) < LOW_CONFIDENCE_THRESHOLD) return;
  if (typeof db.listObjects !== 'function') return;
  try {
    const objects = await db.listObjects(dbUser.id);
    if (!Array.isArray(objects) || objects.length !== 1) return;
    if (diagId) {
      planShortHintShown.set(dbUser.id, diagId);
    }
    await ctx.reply(msg('plan_short_path_hint'));
  } catch (err) {
    console.error('plan_short_hint error', err);
  }
}

async function handlePlanTreatment(ctx, opts = {}) {
  const tgUserId = ctx.from?.id;
  if (!tgUserId) return;
  maybeSendPlanOnboarding(ctx);
  let dbUser = null;
  if (typeof db.ensureUser === 'function') {
    try {
      dbUser = await db.ensureUser(tgUserId);
    } catch (err) {
      console.error('plan_treatment.ensure_user_failed', err);
    }
  }
  if (!dbUser && typeof db.getUserByTgId === 'function') {
    try {
      dbUser = await db.getUserByTgId(tgUserId);
    } catch (err) {
      console.error('plan_treatment.get_user_failed', err);
    }
  }
  const userId = dbUser?.id || tgUserId;
  console.info('plan_treatment.context', {
    tgUserId,
    userId,
    hasDbUser: Boolean(dbUser),
  });
  const pendingTime =
    typeof db.getLatestTimeSessionForUser === 'function'
      ? await db.getLatestTimeSessionForUser(userId)
      : null;
  if (pendingTime && (pendingTime.current_step || '').startsWith('time_')) {
    const pendingStep = pendingTime.current_step || '';
    if (['time_autoplan_lookup', 'time_autoplan_wait'].includes(pendingStep) && typeof db.deletePlanSession === 'function') {
      try {
        await db.deletePlanSession(pendingTime.id);
      } catch (err) {
        console.error('plan_treatment.pending_time_delete_failed', err);
      }
    } else {
      const resumed = await resumePlanTimeSession(ctx, pendingTime);
      if (resumed) return;
    }
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
    const thresholdPct = formatPercent(LOW_CONFIDENCE_THRESHOLD);
    const confidencePct = formatPercent(diagnosis.confidence);
    await replyUserError(ctx, 'LOW_CONFIDENCE', {
      confidence: confidencePct ?? '—',
      threshold: thresholdPct ?? '—',
    });
    return;
  }
  if (dbUser) {
    await maybeSendShortPathHint(ctx, diagnosis, record, dbUser);
    const objectId = record?.object_id ?? dbUser.last_object_id ?? null;
    await logFunnelEvent(db, {
      event: 'plan_treatment_clicked',
      userId: dbUser.id,
      objectId,
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
        const handled = await resumeAutoplanLookup(ctx, session);
        if (!handled) {
          await ctx.reply(msg('plan_autoplan_lookup'));
          if (typeof db.updatePlanSession === 'function') {
            await db.updatePlanSession(session.id, { ttlHours: 72 });
          }
        }
        return true;
      }
      case 'time_autoplan_wait': {
        const handled = await resumeAutoplanLookup(ctx, session);
        if (!handled) {
          await ctx.reply(msg('plan_autoplan_lookup'));
          if (typeof db.updatePlanSession === 'function') {
            await db.updatePlanSession(session.id, { ttlHours: 72 });
          }
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

async function resumeAutoplanLookup(ctx, session) {
  const state = session?.state || {};
  const runId = state.autoplanRunId || state.autoplan_run_id || null;
  if (!runId || typeof db.getAutoplanRunContext !== 'function') return false;
  try {
    const runContext = await db.getAutoplanRunContext(runId);
    if (!runContext) return false;
    const needsLocation = !hasCoordinates(runContext.object?.meta);
    const locationKb = needsLocation ? buildLocationKeyboard(runContext.object?.id) : null;
    if (runContext.run?.status === 'awaiting_window' && runContext.run?.reason === 'no_window') {
      const manualKb = buildManualFallbackKeyboard(
        runContext.plan?.id,
        runContext.stage?.id,
        runContext.run?.stage_option_id || state.stageOptionId || null,
      );
      const keyboard = mergeKeyboards(locationKb, manualKb);
      await ctx.reply(
        msg('plan_autoplan_none', {
          stage: runContext.stage?.title || msg('reminder_stage_fallback'),
        }),
        keyboard ? { reply_markup: keyboard } : undefined,
      );
      if (typeof db.updatePlanSession === 'function') {
        await db.updatePlanSession(session.id, {
          currentStep: 'time_autoplan_wait',
          state: {
            ...(session.state || {}),
            autoplanRunId: runId,
            stageId: runContext.stage?.id || state.stageId || null,
            stageOptionId: runContext.run?.stage_option_id || state.stageOptionId || null,
          },
          ttlHours: 72,
        });
      }
      return true;
    }
    const keyboard = locationKb ? { reply_markup: locationKb } : undefined;
    await ctx.reply(msg('plan_autoplan_lookup'), keyboard);
    if (typeof db.updatePlanSession === 'function') {
      await db.updatePlanSession(session.id, {
        ttlHours: 72,
        currentStep: session.current_step || 'time_autoplan_lookup',
        state: session.state,
      });
    }
    return true;
  } catch (err) {
    console.error('plan_time.autoplan_resume_failed', err);
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

function hasCoordinates(meta = {}) {
  const lat = Number(meta?.lat);
  const lon = Number(meta?.lon);
  return Number.isFinite(lat) && Number.isFinite(lon);
}

function buildLocationKeyboard(objectId) {
  if (!objectId) return null;
  return {
    inline_keyboard: [
      [
        { text: msg('location_geo_button'), callback_data: `plan_location_geo|${objectId}` },
        { text: msg('location_address_button'), callback_data: `plan_location_address|${objectId}` },
      ],
      [{ text: msg('location_cancel_button'), callback_data: `plan_location_cancel|${objectId}` }],
    ],
  };
}

function buildManualFallbackKeyboard(planId, stageId, optionId) {
  if (!planId || !stageId) return null;
  return {
    inline_keyboard: [
      [
        {
          text: msg('plan_manual_start_button'),
          callback_data: `plan_manual_start|${planId}|${stageId}|${optionId || 0}`,
        },
      ],
    ],
  };
}

function mergeKeyboards(...keyboards) {
  const rows = [];
  for (const kb of keyboards) {
    if (kb?.inline_keyboard?.length) {
      rows.push(...kb.inline_keyboard);
    }
  }
  return rows.length ? { inline_keyboard: rows } : null;
}

async function init() {
  try {
    await bot.telegram.setMyCommands([
      { command: 'new', description: '📷 Новый диагноз' },
      { command: 'plans', description: '📋 Мои планы' },
      { command: 'objects', description: '🌱 Мои растения' },
      { command: 'location', description: '📍 Обновить координаты' },
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
    bot.command('location', (ctx) => planCommands.handleLocation(ctx));
    bot.command('use', (ctx) => planCommands.handleUse(ctx));
    bot.command('merge', (ctx) => planCommands.handleMerge(ctx));
    bot.command('edit', (ctx) => planCommands.handleEdit(ctx));
    bot.command('plans', (ctx) => planCommands.handlePlans(ctx));
    bot.command('plan', (ctx) => planCommands.handlePlan(ctx));
    bot.command('done', (ctx) => planCommands.handleDone(ctx));
    bot.command('skip', (ctx) => planCommands.handleSkip(ctx));
    bot.command('stats', (ctx) => planCommands.handleStats(ctx));
    bot.on('location', (ctx) => planCommands.handleLocationShare(ctx));
    bot.command('demo', async (ctx) => {
      await ctx.reply(msg('plan_demo_public_intro'));
      await ctx.reply(msg('plan_demo_public_table'));
      await ctx.reply(msg('plan_demo_public_note'));
    });

    bot.command('reminder', reminderHandler);

    bot.action(/^remind/, reminderHandler);

    bot.command('feedback', (ctx) => feedbackHandler(ctx, pool));

    bot.action(/^pick_opt\|/, planPickHandler);
    bot.action(/^plan_slot_accept\|/, planSlotHandlers.accept);
    bot.action(/^plan_slot_cancel\|/, planSlotHandlers.cancel);
    bot.action(/^plan_slot_reschedule\|/, planSlotHandlers.reschedule);
    bot.action(/^plan_manual_start\|/, planManualHandlers.start);
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
    bot.action(/^plan_location_confirm\|/, planLocationHandler.confirm);
    bot.action(/^plan_location_change\|/, planLocationHandler.change);
    bot.action(/^plan_location_geo\|/, planLocationHandler.requestGeo);
    bot.action(/^plan_location_address\|/, planLocationHandler.requestAddress);
    bot.action(/^plan_location_cancel\|/, planLocationHandler.cancel);
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

    bot.on('text', async (ctx, next) => {
      const handledDetails = await handleObjectDetailsText(ctx);
      if (handledDetails) return undefined;
      const handledLocation = await planCommands.handleLocationText(ctx);
      if (!handledLocation && typeof next === 'function') {
        return next();
      }
      return undefined;
    });
    bot.on('photo', async (ctx) => {
      await photoTips.offerHint(ctx);
      const userId = ctx.from?.id;
      addPhoto(userId, ctx.message);
      schedulePhotoStatus(ctx);
    });

    bot.on('message', messageHandler);

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

    bot.action(/^obj_merge\|(\d+)\|(\d+)/, async (ctx) => {
      const [, sourceRaw, targetRaw] = ctx.callbackQuery.data.split('|');
      await ctx.answerCbQuery();
      const sourceId = Number(sourceRaw);
      const targetId = Number(targetRaw);
      if (!sourceId || !targetId || sourceId === targetId) {
        await ctx.reply(msg('objects_merge_invalid'));
        return;
      }
      try {
        const user = await db.ensureUser(ctx.from.id);
        if (typeof db.mergeObjects !== 'function') {
          await ctx.reply(msg('objects_merge_error'));
          return;
        }
        await db.mergeObjects(user.id, sourceId, targetId);
        await ctx.reply(msg('objects_merge_success', { source: sourceId, target: targetId }));
        if (objectChips) {
          await objectChips.send(ctx);
        }
      } catch (err) {
        console.error('objects merge action error', err);
        await ctx.reply(msg('objects_merge_error'));
      }
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

    bot.action(/^obj_detail\|(variety|note)\|(\d+)/, async (ctx) => {
      const [, field, objectIdRaw] = ctx.callbackQuery.data.split('|');
      await ctx.answerCbQuery();
      const objectId = Number(objectIdRaw);
      if (!objectId || !field) return;
      let object = await getObjectSafe(objectId);
      if (!object || Number(object.user_id) !== Number(ctx.from?.id)) {
        const user = await db.ensureUser(ctx.from.id);
        const list = (await db.listObjects(user.id)) || [];
        object =
          list.find((o) => Number(o.id) === Number(user.last_object_id)) ||
          list.find((o) => Number(o.id) === Number(objectId)) ||
          list[0];
      }
      if (!object) {
        await ctx.reply(msg('objects_not_found'));
        return;
      }
      setDetailsSession(ctx.from.id, object.id, field);
      const promptKey = field === 'variety' ? 'object_details_prompt_variety' : 'object_details_prompt_note';
      await ctx.reply(msg(promptKey, { name: object.name }));
    });

    bot.action(/^obj_detail_skip\|(\d+)/, async (ctx) => {
      const [, objectIdRaw] = ctx.callbackQuery.data.split('|');
      await ctx.answerCbQuery();
      const objectId = Number(objectIdRaw);
      if (objectId && typeof db.updateObjectMeta === 'function') {
        await db.updateObjectMeta(objectId, { details_prompted_at: new Date().toISOString() });
      }
      clearDetailsSession(ctx.from?.id);
      await ctx.reply(msg('object_details_cancelled'));
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
    bot.action(/^plan_plans_filter\|/, async (ctx) => {
      const [, objectIdRaw] = ctx.callbackQuery.data.split('|');
      await ctx.answerCbQuery();
      const filter = objectIdRaw === 'all' ? null : objectIdRaw;
      await planCommands.handlePlans(ctx, { objectId: filter });
    });
    bot.action(/^plan_plans_more\|/, async (ctx) => {
      const [, cursor, objectIdRaw] = ctx.callbackQuery.data.split('|');
      await ctx.answerCbQuery();
      const filter = objectIdRaw === 'all' ? null : objectIdRaw;
      await planCommands.handlePlans(ctx, { objectId: filter, cursor });
    });
    bot.action(/^plan_plan_open\|/, async (ctx) => {
      const [, planIdRaw] = ctx.callbackQuery.data.split('|');
      await ctx.answerCbQuery();
      await planCommands.handleEventAction(ctx, 'open', planIdRaw);
    });
    bot.action(/^plan_overdue_bulk\|/, async (ctx) => {
      const [, action, ids] = ctx.callbackQuery.data.split('|');
      await ctx.answerCbQuery();
      await planCommands.handleOverdueBulk(ctx, action, ids);
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

    bot.action('plan_demo_public', async (ctx) => {
      await ctx.answerCbQuery();
      for (const block of [msg('plan_demo_public_intro'), msg('plan_demo_public_table'), msg('plan_demo_public_note')]) {
        if (block) {
          await ctx.reply(block);
        }
      }
    });

    bot.action('plan_demo_close', async (ctx) => {
      await ctx.answerCbQuery(msg('plan_demo_close_toast'));
    });
    bot.action('plan_my_plans', async (ctx) => {
      await ctx.answerCbQuery();
      await planCommands.handlePlans(ctx);
    });

    bot.action(/^plan_step_cancel\|/, async (ctx) => {
      const [, token] = ctx.callbackQuery.data.split('|');
      await ctx.answerCbQuery();
      const ok = await planFlow.cancelSession(ctx.from?.id, token);
      if (!ok) {
        await replyUserError(ctx, 'BUTTON_EXPIRED');
        return;
      }
      await ctx.reply(msg('plan_step_cancelled'));
    });

    bot.action(/^plan_step_back\|/, async (ctx) => {
      const [, token] = ctx.callbackQuery.data.split('|');
      await ctx.answerCbQuery();
      const restarted = await planFlow.restartSession(ctx, token);
      if (!restarted) {
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

    bot.action('photo_tips', async (ctx) => {
      await photoTips.sendTips(ctx);
    });

    bot.action('photo_album_done', async (ctx) => {
      await ctx.answerCbQuery();
      const userId = ctx.from?.id;
      const state = getPhotoState(userId);
      if (!state.ready || !userId) {
        const need = Math.max(0, MIN_PHOTOS - (state.count || 0));
        await ctx.reply(msg('photo_album_not_ready', { need }));
        return;
      }
      const photo = pickPhotoForAnalysis(userId);
      if (!photo) {
        await ctx.reply(msg('photo_album_not_ready', { need: MIN_PHOTOS }));
        return;
      }
      try {
        await analyzePhoto(deps, ctx, photo);
        clearPhotoSession(userId);
      } catch (err) {
        console.error('photo_album_done analyze failed', err);
        await ctx.reply(msg('diagnose_error'));
      }
    });

    bot.action('photo_album_add', async (ctx) => {
      await ctx.answerCbQuery();
      const text = msg('photo_album_add_more', { max: MAX_PHOTOS });
      if (text) {
        await ctx.reply(text);
      }
    });

    bot.action('photo_album_skip_optional', async (ctx) => {
      await ctx.answerCbQuery();
      const userId = ctx.from?.id;
      if (userId) skipOptionalPhotos(userId);
      const state = getPhotoState(userId);
      const payload = buildPhotoStatusPayload(state);
      const ack = msg('photo_album_skip_optional_done');
      const parts = [ack];
      if (payload?.text) {
        parts.push(payload.text);
      }
      const text = parts.filter(Boolean).join('\n\n');
      if (text) {
        await ctx.reply(text, {
          reply_markup: payload?.reply_markup,
        });
      }
    });

    bot.action('photo_album_reset', async (ctx) => {
      await ctx.answerCbQuery();
      const userId = ctx.from?.id;
      const cleared = clearPhotoSession(userId);
      const reply = cleared ? msg('photo_album_reset_done') : msg('photo_album_reset_empty');
      if (reply) {
        await ctx.reply(reply);
      }
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

    await bot.telegram.setMyCommands([
      { command: 'new', description: msg('command_new_desc') || 'Новый диагноз' },
      { command: 'plans', description: msg('command_plans_desc') || 'Мои планы' },
      { command: 'objects', description: msg('command_objects_desc') || 'Мои растения' },
    ]);
    await bot.launch();
    await reminderScheduler.start();
    await overdueNotifier.start();
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
  overdueNotifier.stop();
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
    await redis.quit();
  } catch (err) {
    console.error('Redis close failed', err);
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
