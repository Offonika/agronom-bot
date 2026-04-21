const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
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
  getDiagnosisContextForMessage,
  extractDiagnosisIdFromReplyMessage,
  rememberDiagnosis,
  buildDiagnosisObjectList,
} = require('./diagnosis');
const { subscribeHandler, buyProHandler, handlePaywallRemind } = require('./payments');
const { historyHandler } = require('./history');
const {
  startHandler,
  helpHandler,
  feedbackHandler,
  cancelAutopayHandler,
  autopayEnableHandler,
  newDiagnosisHandler,
  supportHandler,
  menuHandler,
  getMainMenuActions,
} = require('./commands');
const { msg, sanitizeObjectName } = require('./utils');
const { list } = require('./i18n');
const { createDb } = require('../services/db');
const { createCatalog } = require('../services/catalog');
const { createPlanWizard } = require('./flow/plan_wizard');
const { createPlanPickHandler } = require('./callbacks/plan_pick');
const { createPlanTriggerHandler } = require('./callbacks/plan_trigger');
const { createPlanLocationHandler } = require('./callbacks/plan_location');
const { createPlanManualSlotHandlers } = require('./callbacks/plan_manual_slot');
const { createPlanSlotHandlers } = require('./callbacks/plan_slot');
const { createDiagDetailsHandler } = require('./callbacks/diag_details');
const { createAssistantChat } = require('./assistantChat');
const { createReminderScheduler } = require('./reminders');
const { createOverdueNotifier } = require('./overdueNotifier');
const { createPaywallReminderScheduler } = require('./paywallReminderScheduler');
const { createPlanCommands } = require('./planCommands');
const { createPlanFlow } = require('./planFlow');
const { createPlanSessionsApi } = require('./planSessionsApi');
const { createObjectChips } = require('./objectChips');
const { createBetaFollowupScheduler } = require('./betaFollowup');
const adminCommands = require('./adminCommands');
const { fetchPlanPdf } = require('./planApi');
const betaSurvey = require('./betaSurvey');
const { LOW_CONFIDENCE_THRESHOLD } = require('./messageFormatters/diagnosisMessage');
const { replyUserError } = require('./userErrors');
const { logFunnelEvent } = require('./funnel');
const photoTips = require('./photoTips');
const { createQaIntake } = require('./qaIntake');
const { getDocVersion, sendConsentScreen } = require('./privacyNotice');
const { requirePrivacyConsent } = require('./consentGate');
const support = require('./support');
const { configurePersistence: configureLocationSessionPersistence } = require('./locationSession');
const { createObjectDetailsHandler } = require('./objectDetailsHandler');
const { configurePersistence: configureObjectDetailsPersistence } = require('./objectDetailsSession');
const { configurePersistence: configureRegionPromptPersistence } = require('./regionPromptState');
const {
  configurePersistence: configurePhotoCollectorPersistence,
  addPhotoAsync,
  getState: getPhotoState,
  getStateAsync: getPhotoStateAsync,
  getSamePlantPending,
  clearSamePlantPending,
  pickPrimary: pickPhotoForAnalysis,
  clearSessionAsync: clearPhotoSessionAsync,
  startFollowupSessionAsync,
  setSamePlantPending,
  skipOptionalAsync: skipOptionalPhotosAsync,
  confirmSamePlantAsync,
  denySamePlantAsync,
  MIN_PHOTOS,
  MAX_PHOTOS,
  SAME_PLANT_CHECK_DAYS,
} = require('./photoCollector');
const { analyzePhoto } = require('./diagnosis');

const { formatSlotCard, buildSlotKeyboard } = require('../services/slot_card');
const { createGeocoder } = require('../services/geocoder');

const HOUR_IN_MS = 60 * 60 * 1000;
const PLAN_START_THROTTLE_MS = 2000;
const CONSENT_THROTTLE_MS = 1500;
const planStartGuards = new Map();
const consentGuards = new Map();
const photoReplyTimers = new Map();
const photoLastStatus = new Map();
const photoLastStatusMessage = new Map();
const PHOTO_STATUS_EDIT_WINDOW_MS = Number(process.env.PHOTO_STATUS_EDIT_WINDOW_MS || `${5 * 60 * 1000}`);
const rawFollowupWindowHours = Number(process.env.FOLLOWUP_CASE_WINDOW_HOURS || '72');
const FOLLOWUP_CASE_WINDOW_HOURS =
  Number.isFinite(rawFollowupWindowHours) && rawFollowupWindowHours > 0
    ? rawFollowupWindowHours
    : 72;
const FOLLOWUP_CASE_WINDOW_MS = FOLLOWUP_CASE_WINDOW_HOURS * HOUR_IN_MS;
const consentVersions = {
  privacy: getDocVersion('privacy'),
  offer: getDocVersion('offer'),
  autopay: getDocVersion('autopay'),
  marketing: getDocVersion('marketing'),
};

function formatPercent(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) return null;
  return Math.round(Math.max(0, Math.min(1, value)) * 100);
}

function shouldThrottle(map, key, windowMs) {
  if (!key) return false;
  const now = Date.now();
  const last = map.get(key);
  if (last && now - last < windowMs) return true;
  map.set(key, now);
  return false;
}

async function safeAnswerCbQuery(ctx, text, opts) {
  if (typeof ctx?.answerCbQuery !== 'function') return;
  try {
    await ctx.answerCbQuery(text, opts);
  } catch {
    // ignore answerCbQuery errors (stale/invalid callback)
  }
}

const token =
  process.env.BOT_TOKEN_PROD ||
  process.env.BOT_TOKEN_DEV ||
  process.env.BOT_TOKEN;
if (!token) {
  throw new Error('BOT_TOKEN_PROD or BOT_TOKEN_DEV not set');
}

const tokenSource = process.env.BOT_TOKEN_PROD
  ? 'BOT_TOKEN_PROD'
  : process.env.BOT_TOKEN_DEV
    ? 'BOT_TOKEN_DEV'
    : 'BOT_TOKEN';
console.log(`Telegram bot token source: ${tokenSource}`);

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
configurePhotoCollectorPersistence({ redis });
configureLocationSessionPersistence({ redis });
configureObjectDetailsPersistence({ redis });
configureRegionPromptPersistence({ redis });
betaSurvey.configurePersistence({ redis });
support.configurePersistence({ redis });
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
const qaIntake = createQaIntake({ db });
const catalog = createCatalog(pool);
const reminderScheduler = createReminderScheduler({ bot, db });
const overdueNotifier = createOverdueNotifier({ bot, db });
const paywallReminderScheduler = createPaywallReminderScheduler({ bot, db });
const betaFollowupScheduler = createBetaFollowupScheduler({ bot, db });
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
const assistantChat = createAssistantChat({ db, pool, redis });
const diagDetailsHandler = createDiagDetailsHandler({ db, rememberDiagnosis, safeAnswerCbQuery });
const DETAILS_PROMPT_TTL_MS = Number(process.env.OBJECT_DETAILS_PROMPT_TTL_MS || `${24 * 60 * 60 * 1000}`);
const objectDetailsHandler = createObjectDetailsHandler({ db, objectChips });
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
const deleteConfirmSeen = new Map();
const DELETE_CONFIRM_TTL_MS = 5000;
const diagObjectCreateSeen = new Map();
const DIAG_OBJECT_CREATE_TTL_MS = Number(process.env.DIAG_OBJECT_CREATE_TTL_MS || 2000);

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

function normalizeLocationTag(tag) {
  return (tag || '').trim().toLowerCase();
}

function formatObjectLabel(object) {
  if (!object) return msg('object.default_name');
  const parts = [];
  if (object.meta?.variety) parts.push(object.meta.variety);
  if (object.meta?.note) parts.push(object.meta.note);
  const baseName = sanitizeObjectName(object.name, msg('object.default_name'));
  if (!parts.length) return baseName;
  return `${baseName} • ${parts.join(' / ')}`;
}

function deriveObjectNameFromDiagnosis(payload) {
  const name = String(payload?.crop_ru || payload?.crop || '').trim();
  return name || msg('object.default_name');
}

function buildObjectMetaFromDiagnosis(payload) {
  const meta = { source: 'diagnosis_choice' };
  const variety = String(payload?.variety_ru || payload?.variety || '').trim();
  if (variety) meta.variety = variety;
  const cropRu = String(payload?.crop_ru || '').trim();
  if (cropRu) meta.crop_ru = cropRu;
  return meta;
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

async function updateLastObjectAfterDelete(user, deletedId) {
  if (!user?.last_object_id || Number(user.last_object_id) !== Number(deletedId)) return;
  try {
    const list = (await db.listObjects(user.id)) || [];
    const next = list[0] || null;
    if (typeof db.updateUserLastObject === 'function') {
      await db.updateUserLastObject(user.id, next?.id || null);
    }
  } catch (err) {
    console.error('object delete update last failed', err);
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
  const objectName = sanitizeObjectName(object.name, msg('object.default_name'));
  await bot.telegram.sendMessage(chatId, msg('object_details_intro', { name: objectName }), {
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
      (o) =>
        Number(o.id) !== Number(objectId) &&
        (o.type === current.type ||
          o.name === current.name ||
          (o.location_tag &&
            current.location_tag &&
            normalizeLocationTag(o.location_tag) === normalizeLocationTag(current.location_tag))),
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

async function handleBetaCreateIndoorObject(ctx) {
  if (typeof ctx.answerCbQuery === 'function') {
    try {
      await ctx.answerCbQuery();
    } catch {
      // ignore answer errors
    }
  }
  const tgUserId = ctx.from?.id;
  if (!tgUserId || typeof db.ensureUser !== 'function') {
    await ctx.reply(msg('objects_error'));
    return;
  }
  try {
    const user = await db.ensureUser(tgUserId);
    const objects = typeof db.listObjects === 'function' ? await db.listObjects(user.id) : [];
    let target = objects.find((obj) => obj.type === 'indoor');
    let created = false;
    if (!target && typeof db.createObject === 'function') {
      const name = msg('beta.indoor_object_name') || msg('object.default_name');
      target = await db.createObject(user.id, {
        name,
        type: 'indoor',
        meta: { source: 'beta' },
      });
      created = Boolean(target);
    }
    if (!target) {
      await ctx.reply(msg('objects_error'));
      return;
    }
    if (typeof db.updateUserLastObject === 'function') {
      await db.updateUserLastObject(user.id, target.id);
    }
    const displayName = sanitizeObjectName(target?.name, msg('object.default_name'));
    if (created) {
      await ctx.reply(msg('beta.indoor_created', { name: displayName }));
    } else {
      await ctx.reply(msg('beta.indoor_exists', { name: displayName }));
    }
  } catch (err) {
    console.error('beta indoor create failed', err);
    await ctx.reply(msg('objects_error'));
  }
}

function buildPhotoStatusPayload(state) {
  if (!state) return null;
  const minPhotos = Number.isFinite(Number(state.minPhotos)) && Number(state.minPhotos) > 0
    ? Number(state.minPhotos)
    : MIN_PHOTOS;
  if (state.followupMode) {
    const parts = [
      msg('photo_followup_status', { count: state.count || 0, min: minPhotos, max: MAX_PHOTOS }),
    ];
    if (state.overflow) {
      parts.push(msg('photo_album_overflow', { max: MAX_PHOTOS }));
    }
    if (state.ready) {
      parts.push(msg('photo_followup_ready', { max: MAX_PHOTOS }));
    } else {
      const need = Math.max(0, minPhotos - (state.count || 0));
      parts.push(msg('photo_followup_not_ready', { need }));
    }
    return {
      text: parts.filter(Boolean).join('\n'),
      reply_markup: buildPhotoKeyboard(state.ready, true, (state.count || 0) < MAX_PHOTOS),
    };
  }
  const checklist = buildPhotoChecklist(state.count || 0);
  const parts = [
    msg('photo_album_status', { count: state.count || 0, min: minPhotos, max: MAX_PHOTOS }),
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
    const need = Math.max(0, minPhotos - (state.count || 0));
    parts.push(msg('photo_album_not_ready', { need }));
  }
  const text = parts.filter(Boolean).join('\n');
  return {
    text,
    reply_markup: buildPhotoKeyboard(state.ready, state.optionalSkipped, (state.count || 0) < MAX_PHOTOS),
  };
}

function buildActivePhotoTextPayload(state) {
  if (!state || !(state.count > 0)) return null;
  const payload = buildPhotoStatusPayload(state);
  const introKey = state.followupMode ? 'photo_followup_text_guard' : 'photo_album_text_guard';
  const intro = msg(introKey);
  const text = [intro, payload?.text].filter(Boolean).join('\n\n');
  if (!text) return null;
  return {
    text,
    reply_markup: payload?.reply_markup,
  };
}

function clearPhotoStatus(userId) {
  if (!userId) return;
  const timer = photoReplyTimers.get(userId);
  if (timer) {
    clearTimeout(timer);
    photoReplyTimers.delete(userId);
  }
  photoLastStatus.delete(userId);
  photoLastStatusMessage.delete(userId);
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
      const lastMessage = photoLastStatusMessage.get(userId);
      const isFresh =
        lastMessage &&
        lastMessage.chatId === chatId &&
        Date.now() - lastMessage.ts <= PHOTO_STATUS_EDIT_WINDOW_MS;
      if (isFresh) {
        try {
          await ctx.telegram.editMessageText(
            chatId,
            lastMessage.messageId,
            undefined,
            payload.text,
            { reply_markup: payload.reply_markup, disable_web_page_preview: true },
          );
          photoLastStatus.set(userId, payload.text);
          lastMessage.ts = Date.now();
          return;
        } catch (err) {
          console.debug('photo_status_edit_failed', err?.message || err);
          photoLastStatusMessage.delete(userId);
        }
      }
      const sent = await ctx.telegram.sendMessage(chatId, payload.text, {
        reply_markup: payload.reply_markup,
        reply_to_message_id: undefined,
        allow_sending_without_reply: true,
      });
      photoLastStatus.set(userId, payload.text);
      if (sent?.message_id) {
        photoLastStatusMessage.set(userId, {
          chatId,
          messageId: sent.message_id,
          ts: Date.now(),
        });
      }
    } catch (err) {
      console.error('photo_status_send_failed', err);
    }
  }, 500);
  photoReplyTimers.set(userId, timer);
}

function buildSamePlantKeyboard(caseId) {
  return {
    inline_keyboard: [
      [{ text: msg('same_plant.yes_button') || '✅ Да, то же', callback_data: `same_plant_yes:${caseId}` }],
      [{ text: msg('same_plant.no_button') || '🌿 Нет, другое', callback_data: 'same_plant_no' }],
    ],
  };
}

async function maybeAskSamePlant(ctx, userId) {
  if (!userId || !db?.ensureUser || typeof db.getRecentCaseForSamePlantCheck !== 'function') {
    return false;
  }
  const pending = getSamePlantPending(userId);
  if (pending) {
    const notice = msg('same_plant.pending');
    if (notice) {
      await ctx.reply(notice);
    }
    return true;
  }
  const state = await getPhotoStateAsync(userId);
  if (state?.samePlantChecked) {
    return false;
  }
  let user;
  try {
    user = await db.ensureUser(userId);
  } catch (err) {
    console.error('same_plant.ensureUser failed', err);
    return false;
  }
  if (!user) return false;
  const activeObjectId =
    Number.isFinite(Number(user.last_object_id)) && Number(user.last_object_id) > 0
      ? Number(user.last_object_id)
      : null;
  let recent = null;
  try {
    recent = await db.getRecentCaseForSamePlantCheck(user.id, SAME_PLANT_CHECK_DAYS, activeObjectId);
  } catch (err) {
    console.error('same_plant.fetch failed', err);
    return false;
  }
  if (!recent?.caseId) return false;
  let label = '';
  let age = '';
  if (recent.createdAt) {
    age = describeRecentAge({ created_at: recent.createdAt }) || '';
  }
  if (recent.objectId && typeof db.getObjectById === 'function') {
    try {
      const object = await db.getObjectById(recent.objectId);
      label = sanitizeObjectName(object?.name || '');
    } catch (err) {
      console.error('same_plant.object failed', err);
    }
  }
  if (!label) {
    const parts = [];
    if (recent.crop) parts.push(String(recent.crop).trim());
    if (recent.disease) parts.push(String(recent.disease).trim());
    label = sanitizeObjectName(parts.filter(Boolean).join(' — '));
  }
  setSamePlantPending(userId, recent);
  const promptText = label
    ? (msg('same_plant.prompt_with_label', { label, age }) ||
      `Это то же растение, что и раньше — ${label}${age ? ` (${age})` : ''}?`)
    : (msg('same_plant.prompt') || 'Это то же растение, что и раньше?');
  await ctx.reply(promptText, {
    reply_markup: buildSamePlantKeyboard(recent.caseId),
  });
  return true;
}

async function resumePhotoAnalysis(ctx, userId) {
  const state = await getPhotoStateAsync(userId);
  const minPhotos = Number.isFinite(Number(state?.minPhotos)) && Number(state?.minPhotos) > 0
    ? Number(state.minPhotos)
    : MIN_PHOTOS;
  if (!state?.ready || !userId) {
    const need = Math.max(0, minPhotos - (state?.count || 0));
    const key = state?.followupMode ? 'photo_followup_not_ready' : 'photo_album_not_ready';
    await ctx.reply(msg(key, { need }));
    return false;
  }
  const photo = pickPhotoForAnalysis(userId);
  if (!photo) {
    const key = state?.followupMode ? 'photo_followup_not_ready' : 'photo_album_not_ready';
    await ctx.reply(msg(key, { need: minPhotos }));
    return false;
  }
  try {
    const result = await analyzePhoto(deps, ctx, photo, {
      linkedCaseId: state.linkedCaseId,
      linkedObjectId: state.linkedObjectId,
      photos: state.photos,
      source: state.followupMode ? 'photo_album_followup_done' : 'photo_album_done',
    });
    if (result?.ok) {
      await clearPhotoSessionAsync(userId);
      clearPhotoStatus(userId);
      return true;
    }
    return false;
  } catch (err) {
    console.error('photo_album_done analyze failed', err);
    await ctx.reply(msg('diagnose_error'));
    return false;
  }
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

function isFollowupDiagnosisFresh(record) {
  const created = toDate(record?.created_at);
  if (!created) return false;
  return Date.now() - created.getTime() <= FOLLOWUP_CASE_WINDOW_MS;
}

async function logUserFunnelEventByTg(tgUserId, payload = {}) {
  if (!tgUserId || !payload?.event || typeof db?.ensureUser !== 'function') return;
  try {
    const dbUser = await db.ensureUser(tgUserId);
    if (!dbUser?.id) return;
    await logFunnelEvent(db, {
      event: payload.event,
      userId: dbUser.id,
      objectId: payload.objectId || null,
      planId: payload.planId || null,
      data: payload.data || null,
    });
  } catch (err) {
    console.error('logUserFunnelEventByTg failed', err);
  }
}

async function maybeActivateFollowupFromReply(ctx) {
  const userId = ctx.from?.id;
  const replyMessage = ctx.message?.reply_to_message;
  if (!userId || !replyMessage) return false;
  const replyMessageId = Number(replyMessage?.message_id);
  const chatId = Number(ctx?.chat?.id || ctx?.message?.chat?.id);
  const current = await getPhotoStateAsync(userId);
  if (current?.followupMode) return false;
  const context = getDiagnosisContextForMessage(ctx, userId, { allowFallback: false });
  const diagnosis = context?.diagnosis || null;
  let source = context?.source || null;
  let sourceDiagnosisId =
    Number.isFinite(Number(diagnosis?.recent_diagnosis_id)) && Number(diagnosis.recent_diagnosis_id) > 0
      ? Number(diagnosis.recent_diagnosis_id)
      : Number.isFinite(Number(diagnosis?.id)) && Number(diagnosis.id) > 0
        ? Number(diagnosis.id)
        : null;
  if (!sourceDiagnosisId) {
    sourceDiagnosisId = extractDiagnosisIdFromReplyMessage(replyMessage);
    if (sourceDiagnosisId) {
      source = 'reply_markup';
    }
  }
  if (
    !db?.ensureUser ||
    (typeof db.getRecentDiagnosisById !== 'function' &&
      typeof db.getRecentDiagnosisByMessageContext !== 'function')
  ) {
    return false;
  }

  let dbUser = null;
  try {
    dbUser = await db.ensureUser(userId);
  } catch (err) {
    console.error('photo_followup_reply.ensure_user_failed', err);
    return false;
  }
  if (!dbUser?.id) return false;

  let record = null;
  if (
    !sourceDiagnosisId &&
    Number.isFinite(chatId) &&
    Number.isFinite(replyMessageId) &&
    typeof db.getRecentDiagnosisByMessageContext === 'function'
  ) {
    try {
      record = await db.getRecentDiagnosisByMessageContext(
        dbUser.id,
        chatId,
        replyMessageId,
        FOLLOWUP_CASE_WINDOW_HOURS,
      );
      if (record?.id) {
        sourceDiagnosisId = Number(record.id);
        source = 'message_context_db';
      }
    } catch (err) {
      console.error('photo_followup_reply.fetch_context_failed', err);
    }
  }
  if (!record && sourceDiagnosisId && typeof db.getRecentDiagnosisById === 'function') {
    try {
      record = await db.getRecentDiagnosisById(dbUser.id, sourceDiagnosisId);
    } catch (err) {
      console.error('photo_followup_reply.fetch_failed', err);
      return false;
    }
  }
  if (!record || !isFollowupDiagnosisFresh(record)) {
    return false;
  }

  const payload = record.diagnosis_payload || {};
  const linkedCaseId =
    (Number.isFinite(Number(record.case_id)) && Number(record.case_id) > 0 ? Number(record.case_id) : null) ||
    (Number.isFinite(Number(payload.case_id)) && Number(payload.case_id) > 0 ? Number(payload.case_id) : null);
  const linkedObjectId =
    (Number.isFinite(Number(record.object_id)) && Number(record.object_id) > 0 ? Number(record.object_id) : null) ||
    (Number.isFinite(Number(payload.object_id)) && Number(payload.object_id) > 0 ? Number(payload.object_id) : null);

  clearSamePlantPending(userId);
  await startFollowupSessionAsync(userId, {
    linkedCaseId,
    linkedObjectId,
    sourceDiagnosisId: Number(record.id),
  });
  clearPhotoStatus(userId);

  await logFunnelEvent(db, {
    event: 'followup_auto_activated_from_reply',
    userId: dbUser.id,
    objectId: linkedObjectId,
    data: {
      sourceDiagnosisId: Number(record.id),
      source: source || 'reply',
      linkedCaseId,
    },
  });
  return true;
}

async function activateDiagnosisFollowup(ctx, diagnosisId) {
  const tgUserId = ctx.from?.id;
  if (!tgUserId || !diagnosisId || !db?.ensureUser || !db?.getRecentDiagnosisById) {
    await ctx.reply(msg('diag_followup_invalid'));
    return false;
  }
  let dbUser = null;
  try {
    dbUser = await db.ensureUser(tgUserId);
  } catch (err) {
    console.error('diag_followup.ensure_user_failed', err);
  }
  if (!dbUser) {
    await ctx.reply(msg('diag_followup_invalid'));
    return false;
  }
  let record = null;
  try {
    record = await db.getRecentDiagnosisById(dbUser.id, diagnosisId);
  } catch (err) {
    console.error('diag_followup.fetch_failed', err);
  }
  if (!record || !isFollowupDiagnosisFresh(record)) {
    await ctx.reply(msg('diag_followup_expired'));
    return false;
  }
  const payload = record.diagnosis_payload || {};
  let objectId =
    (Number.isFinite(Number(record.object_id)) && Number(record.object_id) > 0
      ? Number(record.object_id)
      : null) ||
    (Number.isFinite(Number(payload.object_id)) && Number(payload.object_id) > 0
      ? Number(payload.object_id)
      : null);
  let objectName = null;
  if (objectId && typeof db.getObjectById === 'function') {
    try {
      const object = await db.getObjectById(objectId);
      if (object && Number(object.user_id) === Number(dbUser.id)) {
        objectName = sanitizeObjectName(object.name, null);
      } else {
        objectId = null;
      }
    } catch (err) {
      console.error('diag_followup.object_failed', err);
    }
  }
  const caseId =
    (Number.isFinite(Number(record.case_id)) && Number(record.case_id) > 0
      ? Number(record.case_id)
      : null) ||
    (Number.isFinite(Number(payload.case_id)) && Number(payload.case_id) > 0
      ? Number(payload.case_id)
      : null);
  clearSamePlantPending(tgUserId);
  await startFollowupSessionAsync(tgUserId, {
    linkedCaseId: caseId,
    linkedObjectId: objectId,
    sourceDiagnosisId: record.id,
  });
  clearPhotoStatus(tgUserId);
  const intro = msg('diag_followup_ready', {
    name: objectName || sanitizeObjectName(payload.crop_ru || payload.crop, msg('object.default_name')),
    hours: FOLLOWUP_CASE_WINDOW_HOURS,
  });
  if (intro) {
    await ctx.reply(intro);
  }
  const state = await getPhotoStateAsync(tgUserId);
  const payloadStatus = buildPhotoStatusPayload(state);
  if (payloadStatus?.text) {
    await ctx.reply(payloadStatus.text, { reply_markup: payloadStatus.reply_markup });
  }
  return true;
}

async function activateActiveObjectFollowup(ctx) {
  const tgUserId = ctx.from?.id;
  if (!tgUserId || !db?.ensureUser) {
    await ctx.reply(msg('diag_followup_invalid'));
    return false;
  }
  let dbUser = null;
  try {
    dbUser = await db.ensureUser(tgUserId);
  } catch (err) {
    console.error('diag_followup_active.ensure_user_failed', err);
  }
  if (!dbUser) {
    await ctx.reply(msg('diag_followup_invalid'));
    return false;
  }
  const activeObjectId =
    Number.isFinite(Number(dbUser.last_object_id)) && Number(dbUser.last_object_id) > 0
      ? Number(dbUser.last_object_id)
      : null;
  if (!activeObjectId) {
    await ctx.reply(msg('diag_followup_no_recent_object'));
    return false;
  }
  let record = null;
  try {
    if (typeof db.getLatestRecentDiagnosisByObject === 'function') {
      record = await db.getLatestRecentDiagnosisByObject(dbUser.id, activeObjectId);
    } else if (typeof db.getLatestRecentDiagnosis === 'function') {
      const fallback = await db.getLatestRecentDiagnosis(dbUser.id);
      if (fallback && Number(fallback.object_id) === activeObjectId) {
        record = fallback;
      }
    }
  } catch (err) {
    console.error('diag_followup_active.fetch_failed', err);
  }
  if (!record?.id) {
    await ctx.reply(msg('diag_followup_no_recent_object'));
    return false;
  }
  return activateDiagnosisFollowup(ctx, Number(record.id));
}

async function handleActivePhotoSessionText(ctx) {
  const userId = ctx.from?.id;
  const text = typeof ctx.message?.text === 'string' ? ctx.message.text.trim() : '';
  if (!userId || !text || text.startsWith('/')) return false;
  const state = await getPhotoStateAsync(userId);
  if (!(state?.count > 0)) return false;
  const payload = buildActivePhotoTextPayload(state);
  if (!payload?.text) return false;
  await ctx.reply(payload.text, payload.reply_markup ? { reply_markup: payload.reply_markup } : undefined);
  return true;
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
    if (!payload.object_id && record.object_id) {
      payload.object_id = record.object_id;
    }
    if (!payload.case_id && record.case_id) {
      payload.case_id = record.case_id;
    }
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

async function maybeSendPlanOnboarding(ctx, dbUser) {
  const userId = ctx.from?.id;
  if (!userId || planOnboardingShown.has(userId)) return;
  const dbUserId = dbUser?.id;
  if (!dbUserId) return;
  try {
    if (typeof db.listPlansByUser === 'function') {
      const plans = await db.listPlansByUser(dbUserId, 1);
      if (plans.length) return;
    }
    if (typeof db.getLatestRecentDiagnosis === 'function') {
      const recent = await db.getLatestRecentDiagnosis(dbUserId);
      if (recent) return;
    }
  } catch (err) {
    console.error('plan_onboarding.check_failed', err);
  }
  planOnboardingShown.add(userId);
  await ctx.reply(msg('plan_onboarding_steps'), {
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
  await maybeSendPlanOnboarding(ctx, dbUser);
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
  if (requireRecentId && dbUser?.id) {
    await logFunnelEvent(db, {
      event: 'plan_treatment_bound_to_diagnosis',
      userId: dbUser.id,
      objectId: record?.object_id || diagnosis?.object_id || dbUser.last_object_id || null,
      planId: record?.plan_id || null,
      data: {
        diagnosisId: record?.id || requireRecentId,
        source: context.source || null,
        expired,
      },
    });
  }
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
    const needsChoice = diagnosis.require_object_choice && !diagnosis.object_id;
    const startOpts = needsChoice ? { skipAutoFinalize: true } : undefined;
    await planFlow.start(ctx, diagnosis, startOpts);
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
      const reason = runContext.run?.reason || 'unknown';
      const messageKey = needsLocation ? 'plan_autoplan_none_with_location' : 'plan_autoplan_none';
      await ctx.reply(
        msg(messageKey, {
          stage: runContext.stage?.title || msg('reminder_stage_fallback'),
          reason: msg(`plan_autoplan_none_reason_${reason}`) || msg('plan_autoplan_none_reason_unknown'),
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
  const objectName = sanitizeObjectName(slotContext.object?.name, msg('object.default_name'));
  const text = formatSlotCard({
    slot,
    stageName: slotContext.stage?.title,
    objectName,
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
    bot.start(async (ctx) => {
      await startHandler(ctx, pool, { db });
      await bot.telegram.setChatMenuButton(ctx.chat.id, { type: 'commands' });
    });

    bot.command('subscribe', async (ctx) => {
      await subscribeHandler(ctx, pool);
    });

    bot.command('new', async (ctx) => newDiagnosisHandler(ctx));
    bot.command('menu', async (ctx) => menuHandler(ctx));
    bot.command('assistant', (ctx) => assistantChat.start(ctx));

    bot.command('help', (ctx) => helpHandler(ctx));
    bot.command('support', async (ctx) => supportHandler(ctx));

    bot.command('autopay_enable', async (ctx) => {
      await autopayEnableHandler(ctx, pool);
    });

    bot.command('cancel_autopay', async (ctx) => {
      await cancelAutopayHandler(ctx, pool);
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
    bot.command('skip', async (ctx) => {
      const handled = await betaSurvey.handleSkipCommand(ctx, db);
      if (handled) return;
      return planCommands.handleSkip(ctx);
    });
    bot.command('stats', (ctx) => planCommands.handleStats(ctx));
    bot.on('location', (ctx) => planCommands.handleLocationShare(ctx));
    bot.command('demo', async (ctx) => {
      await ctx.reply(msg('plan_demo_public_intro'));
      await ctx.reply(msg('plan_demo_public_table'));
      await ctx.reply(msg('plan_demo_public_note'));
    });

    bot.command('feedback', (ctx) => feedbackHandler(ctx, pool));
    bot.command('qa', async (ctx) => {
      await qaIntake.handleCommand(ctx);
    });
    bot.command('beta_add', (ctx) => adminCommands.handleBetaAdd(ctx, db));
    bot.command('beta_remove', (ctx) => adminCommands.handleBetaRemove(ctx, db));
    bot.command('beta_list', (ctx) => adminCommands.handleBetaList(ctx, db));

    bot.action(/^pick_opt\|/, planPickHandler);
    bot.action(/^qa_/, async (ctx) => {
      const handled = await qaIntake.handleCallback(ctx);
      if (!handled) {
        await safeAnswerCbQuery(ctx);
      }
    });
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
    bot.action(/^diag_object_choose\|/, async (ctx) => {
      const [, diagnosisId] = ctx.callbackQuery.data.split('|');
      await safeAnswerCbQuery(ctx);
      if (!diagnosisId) {
        await ctx.reply(msg('diag_object_error'));
        return;
      }
      const tgUserId = ctx.from?.id;
      if (!tgUserId) return;
      try {
        const user = await db.ensureUser(tgUserId);
        const objects = await db.listObjects(user.id);
        if (!Array.isArray(objects) || objects.length < 1) {
          const text =
            msg('diag_object_no_objects') || msg('plan_object_no_objects') || msg('assistant.no_objects') || msg('photo_prompt');
          await ctx.reply(text, {
            reply_markup: {
              inline_keyboard: [
                [{ text: msg('diag_object_create_button'), callback_data: `diag_object_create|${diagnosisId}` }],
              ],
            },
          });
          return;
        }
        const keyboard = buildDiagnosisObjectList(objects, diagnosisId);
        if (!keyboard) {
          await ctx.reply(msg('diag_object_error'));
          return;
        }
        await ctx.reply(msg('diag_object_pick_prompt'), { reply_markup: keyboard });
      } catch (err) {
        console.error('diag_object_choose failed', err);
        await ctx.reply(msg('diag_object_error'));
      }
    });
    bot.action(/^diag_object_pick\|/, async (ctx) => {
      const [, diagnosisIdRaw, objectIdRaw] = ctx.callbackQuery.data.split('|');
      await safeAnswerCbQuery(ctx);
      const diagnosisId = Number(diagnosisIdRaw);
      const objectId = Number(objectIdRaw);
      const tgUserId = ctx.from?.id;
      if (!tgUserId || !diagnosisId || !objectId) {
        await ctx.reply(msg('diag_object_error'));
        return;
      }
      try {
        const user = await db.ensureUser(tgUserId);
        const object = await db.getObjectById(objectId);
        if (!object || Number(object.user_id) !== Number(user.id)) {
          await ctx.reply(msg('diag_object_error'));
          return;
        }
        if (typeof db.updateUserLastObject === 'function') {
          await db.updateUserLastObject(user.id, object.id);
        }
        if (typeof db.linkRecentDiagnosisToPlan === 'function') {
          await db.linkRecentDiagnosisToPlan({ diagnosisId, objectId: object.id });
        }
        if (typeof db.getRecentDiagnosisById === 'function') {
          const record = await db.getRecentDiagnosisById(user.id, diagnosisId);
          if (record?.diagnosis_payload) {
            const payload = record.diagnosis_payload;
            payload.object_id = object.id;
            payload.require_object_choice = false;
            rememberDiagnosis(tgUserId, payload);
          }
        }
        await ctx.reply(msg('diag_object_linked', { name: formatObjectLabel(object) }));
      } catch (err) {
        console.error('diag_object_pick failed', err);
        await ctx.reply(msg('diag_object_error'));
      }
    });
    bot.action(/^diag_object_create\|/, async (ctx) => {
      const [, diagnosisIdRaw] = ctx.callbackQuery.data.split('|');
      await safeAnswerCbQuery(ctx);
      const diagnosisId = Number(diagnosisIdRaw);
      const tgUserId = ctx.from?.id;
      if (!tgUserId || !diagnosisId) {
        await ctx.reply(msg('diag_object_error'));
        return;
      }
      const createKey = `${tgUserId}:${diagnosisId}`;
      const lastSeen = diagObjectCreateSeen.get(createKey) || 0;
      if (Date.now() - lastSeen < DIAG_OBJECT_CREATE_TTL_MS) {
        return;
      }
      try {
        const user = await db.ensureUser(tgUserId);
        if (typeof db.getRecentDiagnosisById !== 'function') {
          await ctx.reply(msg('diag_object_error'));
          return;
        }
        const record = await db.getRecentDiagnosisById(user.id, diagnosisId);
        const payload = record?.diagnosis_payload;
        if (!payload || typeof db.createObject !== 'function') {
          await ctx.reply(msg('diag_object_error'));
          return;
        }
        if (record?.object_id && typeof db.getObjectById === 'function') {
          const existing = await db.getObjectById(record.object_id);
          if (existing && Number(existing.user_id) === Number(user.id)) {
            if (typeof db.updateUserLastObject === 'function') {
              await db.updateUserLastObject(user.id, existing.id);
            }
            payload.object_id = existing.id;
            payload.require_object_choice = false;
            rememberDiagnosis(tgUserId, payload);
            await ctx.reply(msg('diag_object_linked', { name: formatObjectLabel(existing) }));
            return;
          }
        }
        diagObjectCreateSeen.set(createKey, Date.now());
        const name = deriveObjectNameFromDiagnosis(payload);
        const created = await db.createObject(user.id, {
          name,
          type: payload.crop || null,
          locationTag: payload.region || null,
          meta: buildObjectMetaFromDiagnosis(payload),
        });
        if (created && typeof db.updateUserLastObject === 'function') {
          await db.updateUserLastObject(user.id, created.id);
        }
        if (created && typeof db.linkRecentDiagnosisToPlan === 'function') {
          await db.linkRecentDiagnosisToPlan({ diagnosisId, objectId: created.id });
        }
        if (created && payload) {
          payload.object_id = created.id;
          payload.require_object_choice = false;
          rememberDiagnosis(tgUserId, payload);
        }
        await ctx.reply(msg('diag_object_created', { name: formatObjectLabel(created) }));
      } catch (err) {
        console.error('diag_object_create failed', err);
        diagObjectCreateSeen.delete(createKey);
        await ctx.reply(msg('diag_object_error'));
      }
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

    bot.action(/^consent_accept\|/, async (ctx) => {
      const parts = ctx.callbackQuery.data.split('|');
      const docType = parts[1];
      const nextAction = parts[2] || null;
      const autopayFlag = parts[3] === '1';
      const docVersion = consentVersions[docType];
      if (!docType || (!docVersion && docType !== 'all')) {
        await ctx.answerCbQuery();
        return;
      }
      const userId = ctx.from?.id;
      if (shouldThrottle(consentGuards, `consent:${userId}`, CONSENT_THROTTLE_MS)) {
        await ctx.answerCbQuery();
        return;
      }
      let dbUser = null;
      if (userId && db?.ensureUser) {
        try {
          dbUser = await db.ensureUser(userId);
        } catch (err) {
          console.error('consent ensureUser failed', err);
        }
      }
      if (!dbUser || !db?.acceptConsent) {
        await ctx.answerCbQuery();
        return;
      }
      const meta = {
        tg_chat_id: ctx.chat?.id || null,
        message_id: ctx.callbackQuery?.message?.message_id || null,
        callback_data: ctx.callbackQuery?.data || null,
      };
      if (docType === 'all') {
        await db.acceptConsent(dbUser.id, 'privacy', consentVersions.privacy, 'bot', meta);
        await db.acceptConsent(dbUser.id, 'offer', consentVersions.offer, 'bot', meta);
      } else {
        await db.acceptConsent(dbUser.id, docType, docVersion, 'bot', meta);
      }
      await ctx.answerCbQuery();
      await ctx.reply(msg('consent_accepted'));
      if (nextAction === 'pay') {
        await buyProHandler(ctx, pool, 3000, 60000, autopayFlag);
      } else if (nextAction === 'subscribe') {
        await subscribeHandler(ctx, pool);
      }
    });

    bot.action('autopay_confirm', async (ctx) => {
      await ctx.answerCbQuery();
      const userId = ctx.from?.id;
      if (!userId || !db?.ensureUser || !db?.acceptConsent) return;
      if (shouldThrottle(consentGuards, `autopay:${userId}`, CONSENT_THROTTLE_MS)) return;
      let dbUser = null;
      try {
        dbUser = await db.ensureUser(userId);
      } catch (err) {
        console.error('autopay confirm ensureUser failed', err);
        return;
      }
      if (!dbUser) return;
      if (typeof db.getConsentStatus === 'function') {
        const privacyConsent = await db.getConsentStatus(dbUser.id, 'privacy');
        const offerConsent = await db.getConsentStatus(dbUser.id, 'offer');
        const privacyOk =
          privacyConsent &&
          privacyConsent.status &&
          privacyConsent.doc_version === consentVersions.privacy;
        const offerOk =
          offerConsent && offerConsent.status && offerConsent.doc_version === consentVersions.offer;
        if (!privacyOk || !offerOk) {
          await sendConsentScreen(ctx, { acceptCallback: 'consent_accept|all|subscribe' });
          return;
        }
      }
      const meta = {
        tg_chat_id: ctx.chat?.id || null,
        message_id: ctx.callbackQuery?.message?.message_id || null,
        callback_data: ctx.callbackQuery?.data || null,
      };
      await db.acceptConsent(dbUser.id, 'autopay', consentVersions.autopay, 'bot', meta);
      await buyProHandler(ctx, pool, 3000, 60000, true);
    });

    bot.action('autopay_cancel', async (ctx) => {
      await ctx.answerCbQuery();
      await subscribeHandler(ctx, pool);
    });

    bot.action('subscribe_back', async (ctx) => {
      await ctx.answerCbQuery();
      await menuHandler(ctx);
    });

    bot.on('text', async (ctx, next) => {
      const handledQaText = await qaIntake.handleText(ctx);
      if (handledQaText) return undefined;
      if (qaIntake.isQaChat(ctx.chat?.id)) return undefined;
      const handledSupport = await support.handleSupportText(ctx);
      if (handledSupport) return undefined;
      const handledSurvey = await betaSurvey.handleComment(ctx, db);
      if (handledSurvey) return undefined;
      const handledDetails = await objectDetailsHandler.handleText(ctx);
      if (handledDetails) return undefined;
      const handledLocation = await planCommands.handleLocationText(ctx);
      if (!handledLocation) {
        const text = ctx.message?.text?.trim();
        const menuActions = getMainMenuActions();
        const menuCommand = text ? menuActions[text] : null;
        if (menuCommand) {
          const menuHandlers = {
            new: (ctx) => newDiagnosisHandler(ctx),
            objects: (ctx) => planCommands.handleObjects(ctx),
            assistant: (ctx) => assistantChat.start(ctx),
            location: (ctx) => planCommands.handleLocation(ctx),
            edit: (ctx) => planCommands.handleEdit(ctx),
            plans: (ctx) => planCommands.handlePlans(ctx),
          };
          const handler = menuHandlers[menuCommand];
          if (handler) {
            await handler(ctx);
            return undefined;
          }
        }
      }
      if (!handledLocation) {
        const handledPhotoText = await handleActivePhotoSessionText(ctx);
        if (handledPhotoText) return undefined;
      }
      if (!handledLocation && typeof next === 'function') {
        return next();
      }
      return undefined;
    });
    bot.on('photo', async (ctx) => {
      if (qaIntake.isQaChat(ctx.chat?.id)) {
        await qaIntake.handlePhoto(ctx);
        return;
      }
      const allowed = await requirePrivacyConsent(ctx, db, {
        privacy: consentVersions.privacy,
        offer: consentVersions.offer,
      });
      if (!allowed) return;
      await photoTips.offerHint(ctx);
      const userId = ctx.from?.id;
      const autoActivatedFromReply = await maybeActivateFollowupFromReply(ctx);
      await addPhotoAsync(userId, ctx.message);
      const state = await getPhotoStateAsync(userId);
      if (state?.followupMode) {
        await logUserFunnelEventByTg(userId, {
          event: 'photo_routed_to_followup',
          objectId: state.linkedObjectId || null,
          data: {
            source: autoActivatedFromReply ? 'reply_auto' : 'followup_session',
            linkedCaseId: state.linkedCaseId || null,
            sourceDiagnosisId: state.sourceDiagnosisId || null,
          },
        });
      }
      schedulePhotoStatus(ctx);
    });

    bot.on('message', async (ctx) => {
      if (qaIntake.isQaChat(ctx.chat?.id)) {
        const handled = await qaIntake.handleAnyMessage(ctx);
        if (handled) return;
        return;
      }
      const activePhotoState = await getPhotoStateAsync(ctx.from?.id);
      const messageText = typeof ctx.message?.text === 'string' ? ctx.message.text.trim() : '';
      if (messageText && !messageText.startsWith('/') && activePhotoState?.count > 0) {
        return;
      }
      const handled = await assistantChat.handleMessage(ctx);
      if (!handled) {
        await messageHandler({ pool }, ctx);
      }
    });

    bot.action('plan_treatment', async (ctx) => {
      await ctx.answerCbQuery();
      await handlePlanTreatment(ctx);
    });

    bot.action(/^plan_treatment\|(\d+)$/, async (ctx) => {
      await ctx.answerCbQuery();
      const diagnosisId = Number(ctx.match?.[1]);
      if (!diagnosisId) {
        await replyUserError(ctx, 'BUTTON_EXPIRED');
        return;
      }
      await handlePlanTreatment(ctx, { requireRecentId: diagnosisId });
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

    bot.command('objects_merge', (ctx) => planCommands.handleMerge(ctx));
    bot.command('objectsmerge', (ctx) => planCommands.handleMerge(ctx));

    bot.action('obj_edit_pick', async (ctx) => {
      await ctx.answerCbQuery();
      if (typeof planCommands.handleEditPick === 'function') {
        await planCommands.handleEditPick(ctx);
      }
    });

    bot.action(/^obj_edit_select\|(\d+)/, async (ctx) => {
      const [, objectIdRaw] = ctx.callbackQuery.data.split('|');
      await ctx.answerCbQuery();
      const objectId = Number(objectIdRaw);
      if (!objectId) return;
      if (typeof planCommands.handleEditSelect === 'function') {
        await planCommands.handleEditSelect(ctx, objectId);
      }
    });

    bot.action(/^obj_detail\|(variety|note|rename)\|(\d+)/, async (ctx) => {
      const [, field, objectIdRaw] = ctx.callbackQuery.data.split('|');
      await ctx.answerCbQuery();
      const objectId = Number(objectIdRaw);
      if (!objectId || !field) return;
      await objectDetailsHandler.startPrompt(ctx, { field, objectId });
    });

    bot.action(/^obj_delete_confirm\|(\d+)/, async (ctx) => {
      const [, objectIdRaw] = ctx.callbackQuery.data.split('|');
      await ctx.answerCbQuery();
      const objectId = Number(objectIdRaw);
      if (!objectId) return;
      const userId = ctx.from?.id;
      if (userId) {
        const messageId = ctx.callbackQuery?.message?.message_id || '0';
        const key = `${userId}:${objectId}:${messageId}`;
        const last = deleteConfirmSeen.get(key) || 0;
        const ts = now();
        if (ts - last < DELETE_CONFIRM_TTL_MS) {
          return;
        }
        deleteConfirmSeen.set(key, ts);
      }
      const object = await getObjectSafe(objectId);
      const name = sanitizeObjectName(object?.name, msg('object.default_name'));
      const keyboard = {
        inline_keyboard: [
          [{ text: msg('object_delete_button_confirm'), callback_data: `obj_delete_yes|${objectId}` }],
          [{ text: msg('object_delete_button_cancel'), callback_data: `obj_delete_no|${objectId}` }],
        ],
      };
      const text = msg('object_delete_confirm', { name });
      if (typeof ctx.editMessageText === 'function') {
        try {
          await ctx.editMessageText(text, { reply_markup: keyboard });
          return;
        } catch (err) {
          if (!String(err?.description || '').includes('message is not modified')) {
            console.error('object_delete_confirm.edit_failed', err);
          }
        }
      }
      await ctx.reply(text, { reply_markup: keyboard });
    });

    bot.action(/^obj_delete_no\|(\d+)/, async (ctx) => {
      await ctx.answerCbQuery();
      await ctx.reply(msg('object_delete_cancelled'));
    });

    bot.action(/^obj_delete_yes\|(\d+)/, async (ctx) => {
      const [, objectIdRaw] = ctx.callbackQuery.data.split('|');
      await ctx.answerCbQuery();
      const objectId = Number(objectIdRaw);
      if (!objectId) return;
      const user = await db.ensureUser(ctx.from.id);
      const object = await getObjectSafe(objectId);
      if (!object || Number(object.user_id) !== Number(user.id)) {
        await ctx.reply(msg('objects_not_found'));
        return;
      }
      const planCount = typeof db.countPlansByObject === 'function'
        ? await db.countPlansByObject(objectId)
        : (await db.listPlansByObject(objectId, 1)).length;
      if (planCount > 0) {
        const objectName = sanitizeObjectName(object.name, msg('object.default_name'));
        await ctx.reply(msg('object_delete_with_plans_confirm', { name: objectName, count: planCount }), {
          reply_markup: {
            inline_keyboard: [
              [{ text: msg('object_delete_with_plans_button'), callback_data: `obj_delete_force|${objectId}` }],
              [{ text: msg('object_delete_button_cancel'), callback_data: `obj_delete_no|${objectId}` }],
            ],
          },
        });
        return;
      }
      let deleted = typeof db.deleteObject === 'function' ? await db.deleteObject(user.id, objectId) : null;
      if (!deleted && typeof db.deleteObjectById === 'function') {
        deleted = await db.deleteObjectById(objectId);
        if (deleted) {
          console.warn('object_delete.force_fallback', { userId: user.id, objectId });
        }
      }
      if (!deleted) {
        const stillExists = await getObjectSafe(objectId);
        if (stillExists) {
          console.warn('object_delete.missing_row', { userId: user.id, objectId });
          await ctx.reply(msg('objects_error'));
          return;
        }
        deleted = object;
      }
      await updateLastObjectAfterDelete(user, objectId);
      clearDetailsSession(ctx.from?.id);
      const deletedName = sanitizeObjectName(deleted?.name, msg('object.default_name'));
      await ctx.reply(msg('object_delete_done', { name: deletedName }));
    });

    bot.action(/^obj_delete_force\|(\d+)/, async (ctx) => {
      const [, objectIdRaw] = ctx.callbackQuery.data.split('|');
      await ctx.answerCbQuery();
      const objectId = Number(objectIdRaw);
      if (!objectId) return;
      const user = await db.ensureUser(ctx.from.id);
      const object = await getObjectSafe(objectId);
      if (!object || Number(object.user_id) !== Number(user.id)) {
        await ctx.reply(msg('objects_not_found'));
        return;
      }
      if (typeof db.deletePlansForObject === 'function') {
        try {
          await db.deletePlansForObject(user.id, objectId);
        } catch (err) {
          console.error('object_delete.delete_plans_failed', { userId: user.id, objectId, err });
        }
      } else if (typeof db.cancelPlansForObject === 'function') {
        try {
          await db.cancelPlansForObject(user.id, objectId);
        } catch (err) {
          console.error('object_delete.cancel_plans_failed', { userId: user.id, objectId, err });
        }
      }
      let deleted = typeof db.deleteObject === 'function' ? await db.deleteObject(user.id, objectId) : null;
      if (!deleted && typeof db.deleteObjectById === 'function') {
        deleted = await db.deleteObjectById(objectId);
        if (deleted) {
          console.warn('object_delete_force.fallback', { userId: user.id, objectId });
        }
      }
      if (!deleted) {
        const stillExists = await getObjectSafe(objectId);
        if (stillExists) {
          console.warn('object_delete_force.missing_row', { userId: user.id, objectId });
          await ctx.reply(msg('objects_error'));
          return;
        }
        deleted = object;
      }
      await updateLastObjectAfterDelete(user, objectId);
      clearDetailsSession(ctx.from?.id);
      const deletedName = sanitizeObjectName(deleted?.name, msg('object.default_name'));
      await ctx.reply(msg('object_delete_done_force', { name: deletedName }));
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
      if (typeof db.getLatestPlanSessionForUser === 'function') {
        try {
          const user = await db.ensureUser(ctx.from.id);
          const session = await db.getLatestPlanSessionForUser(user.id);
          if (session?.token) {
            await planFlow.choose(ctx, session.token);
            return;
          }
        } catch (err) {
          console.error('plan_error_objects.session_failed', err);
        }
      }
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

    bot.action(/^plan_export_pdf\|/, async (ctx) => {
      const [, planIdRaw] = ctx.callbackQuery.data.split('|');
      await ctx.answerCbQuery();
      const planId = Number(planIdRaw);
      if (!planId) {
        await ctx.reply(msg('plan_export_error'));
        return;
      }
      let user = null;
      try {
        user = await db.ensureUser(ctx.from?.id);
      } catch (err) {
        console.error('plan_export.ensure_user_failed', err);
      }
      if (!user?.api_key) {
        await ctx.reply(msg('plan_export_error'));
        return;
      }
      try {
        const buffer = await fetchPlanPdf({
          planId,
          userId: user.id,
          apiKey: user.api_key,
        });
        const caption = msg('plan_export_ready');
        await ctx.replyWithDocument(
          { source: buffer, filename: `plan-${planId}.pdf` },
          caption ? { caption } : undefined,
        );
      } catch (err) {
        console.error('plan_export.failed', err);
        await ctx.reply(msg('plan_export_error'));
      }
    });
    bot.action('ask_products', async (ctx) => {
      await ctx.answerCbQuery();
      await replyFaq(ctx, 'regional_products');
    });

    // Marketing: Share diagnosis result
    bot.action(/^share_diag:(.*)$/, async (ctx) => {
      await ctx.answerCbQuery();
      const diagId = ctx.match?.[1] || '';
      const userId = ctx.from?.id;

      // Get last diagnosis for share text
      let disease = '';
      try {
        const lastDiag = getLastDiagnosis(ctx.from?.id);
        disease = lastDiag?.disease_name_ru || lastDiag?.disease || '';
      } catch (err) {
        console.error('share_diag.getLastDiagnosis failed', err);
      }

      // Log share event
      try {
        const user = await db.ensureUser(userId);
        await logFunnelEvent(db, {
          event: 'share_clicked',
          userId: user?.id,
          data: { diagnosis_id: diagId, disease },
        });
      } catch (err) {
        console.error('share_diag.logFunnelEvent failed', err);
      }

      // Generate share text
      const shareText = disease
        ? msg('share.text', { disease }) || `🌱 Нашёл проблему у растения: ${disease}\n\nПроверь своё → @AgronommAI_bot`
        : '🌱 Проверил своё растение с AI-агрономом! Попробуйте тоже → @AgronommAI_bot';

      await ctx.reply(shareText, {
        reply_markup: {
          inline_keyboard: [
            [{ text: '📲 Переслать друзьям', switch_inline_query: shareText.slice(0, 256) }],
          ],
        },
      });
	    });
	    bot.action('assistant_entry', async (ctx) => {
	      // Callback queries can go stale if the bot is busy (e.g. waiting for OpenAI).
	      // Never fail the whole handler just because Telegram rejected the callback ack.
	      await safeAnswerCbQuery(ctx);
	      await assistantChat.start(ctx);
	    });
	    bot.action('assistant_choose_object', async (ctx) => {
	      await safeAnswerCbQuery(ctx);
	      await assistantChat.chooseObject(ctx);
	    });
	    bot.action('assistant_clear_context', async (ctx) => {
	      await assistantChat.clearContext(ctx);
	    });
	    bot.action(/^assistant_object\|/, async (ctx) => {
	      const [, objectId] = ctx.callbackQuery.data.split('|');
	      await safeAnswerCbQuery(ctx);
	      await assistantChat.pickObject(ctx, objectId);
	    });
	    bot.action(/^assistant_pin\|/, async (ctx) => {
	      const [, proposalId, objectIdRaw] = ctx.callbackQuery.data.split('|');
	      await safeAnswerCbQuery(ctx);
	      const objectId = objectIdRaw ? Number(objectIdRaw) : null;
	      await assistantChat.confirm(ctx, proposalId, objectId);
	    });
	    bot.action('assistant_continue', async (ctx) => {
	      await safeAnswerCbQuery(ctx);
	      await assistantChat.continueChat(ctx);
	    });

    bot.action('reshoot_photo', async (ctx) => {
      await ctx.answerCbQuery();
      const tips = list('reshoot.tips').map((tip) => `• ${tip}`).join('\n');
      const text = [msg('reshoot.action'), tips].filter(Boolean).join('\n');
      return ctx.reply(text);
    });

    bot.action(/^diag_followup\|(\d+)$/, async (ctx) => {
      await safeAnswerCbQuery(ctx);
      const diagnosisId = Number(ctx.match?.[1]);
      if (!diagnosisId) {
        await ctx.reply(msg('diag_followup_invalid'));
        return;
      }
      await activateDiagnosisFollowup(ctx, diagnosisId);
    });

    bot.action('diag_followup_active', async (ctx) => {
      await safeAnswerCbQuery(ctx);
      await activateActiveObjectFollowup(ctx);
    });

    bot.action(/^diag_details\|(\d+)$/, diagDetailsHandler);

    bot.action('photo_tips', async (ctx) => {
      await photoTips.sendTips(ctx);
    });

    bot.action('photo_album_done', async (ctx) => {
      await ctx.answerCbQuery();
      const userId = ctx.from?.id;
      const state = await getPhotoStateAsync(userId);
      if (!state.ready || !userId) {
        const minPhotos =
          Number.isFinite(Number(state?.minPhotos)) && Number(state?.minPhotos) > 0
            ? Number(state.minPhotos)
            : MIN_PHOTOS;
        const need = Math.max(0, minPhotos - (state.count || 0));
        const key = state?.followupMode ? 'photo_followup_not_ready' : 'photo_album_not_ready';
        await ctx.reply(msg(key, { need }));
        return;
      }
      const allowed = await requirePrivacyConsent(ctx, db, {
        privacy: consentVersions.privacy,
        offer: consentVersions.offer,
      });
      if (!allowed) return;
      if (await maybeAskSamePlant(ctx, userId)) {
        return;
      }
      await resumePhotoAnalysis(ctx, userId);
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
      if (userId) await skipOptionalPhotosAsync(userId);
      const state = await getPhotoStateAsync(userId);
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
      const cleared = await clearPhotoSessionAsync(userId);
      clearPhotoStatus(userId);
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

    bot.action('support_cancel', async (ctx) => {
      await ctx.answerCbQuery();
      await support.cancel(ctx);
    });

    bot.action(/^clarify_crop\|/, async (ctx) => {
      const [, optionId] = ctx.callbackQuery.data.split('|');
      await handleClarifySelection(ctx, optionId);
    });

    // Marketing: "Same plant?" confirmation
    bot.action(/^same_plant_yes:(\d+)$/, async (ctx) => {
      await ctx.answerCbQuery();
      const caseId = parseInt(ctx.match?.[1], 10);
      const { getSamePlantPending: getPendingSamePlant } = require('./photoCollector');
      const pending = getPendingSamePlant(ctx.from?.id);
      await confirmSamePlantAsync(ctx.from?.id, caseId, pending?.objectId || null);
      await ctx.reply(msg('same_plant.using_same') || 'Отлично, продолжаю с прошлым кейсом.');
      await resumePhotoAnalysis(ctx, ctx.from?.id);

      // Log event
      try {
        let user = null;
        try {
          user = ctx.from?.id ? await db.ensureUser(ctx.from.id) : null;
        } catch (err) {
          console.error('same_plant_yes.ensureUser failed', err);
        }
        await logFunnelEvent(db, {
          event: 'same_plant_confirmed',
          userId: user?.id,
          data: { case_id: caseId },
        });
      } catch (err) {
        console.error('same_plant_yes.logFunnelEvent failed', err);
      }
    });

    bot.action('same_plant_no', async (ctx) => {
      await ctx.answerCbQuery();
      await denySamePlantAsync(ctx.from?.id);
      await ctx.reply(msg('same_plant.new_case') || 'Хорошо, начинаю новый разбор.');
      await resumePhotoAnalysis(ctx, ctx.from?.id);

      // Log event
      try {
        let user = null;
        try {
          user = ctx.from?.id ? await db.ensureUser(ctx.from.id) : null;
        } catch (err) {
          console.error('same_plant_no.ensureUser failed', err);
        }
        await logFunnelEvent(db, {
          event: 'same_plant_denied',
          userId: user?.id,
        });
      } catch (err) {
        console.error('same_plant_no.logFunnelEvent failed', err);
      }
    });

    bot.action('beta_create_indoor', async (ctx) => {
      await handleBetaCreateIndoorObject(ctx);
    });

    bot.action(/^beta_survey_q1\|/, async (ctx) => {
      const [, caseIdRaw, score] = ctx.callbackQuery.data.split('|');
      await ctx.answerCbQuery();
      const caseId = Number(caseIdRaw);
      await betaSurvey.handleQ1(ctx, db, caseId, score);
    });

    bot.action(/^beta_survey_q2\|/, async (ctx) => {
      const [, feedbackIdRaw, score] = ctx.callbackQuery.data.split('|');
      await ctx.answerCbQuery();
      const feedbackId = Number(feedbackIdRaw);
      await betaSurvey.handleQ2(ctx, db, feedbackId, score);
    });

    bot.action(/^beta_survey_skip\|/, async (ctx) => {
      const [, feedbackIdRaw] = ctx.callbackQuery.data.split('|');
      await ctx.answerCbQuery();
      const feedbackId = Number(feedbackIdRaw);
      await betaSurvey.handleSkip(ctx, db, feedbackId);
    });

    bot.action(/^beta_followup_action\|/, async (ctx) => {
      const [, followupIdRaw, choice] = ctx.callbackQuery.data.split('|');
      await ctx.answerCbQuery();
      const followupId = Number(followupIdRaw);
      await betaFollowupScheduler.handleAction(ctx, followupId, choice);
    });

    bot.action(/^beta_followup_result\|/, async (ctx) => {
      const [, followupIdRaw, choice] = ctx.callbackQuery.data.split('|');
      await ctx.answerCbQuery();
      const followupId = Number(followupIdRaw);
      await betaFollowupScheduler.handleResult(ctx, followupId, choice);
    });

    bot.action('buy_pro', async (ctx) => {
      await buyProHandler(ctx, pool);
    });

    bot.action(/^paywall_remind\|/, async (ctx) => {
      await handlePaywallRemind(ctx, pool);
    });

    bot.action('autopay_enable', async (ctx) => {
      await ctx.answerCbQuery();
      await autopayEnableHandler(ctx, pool);
    });

    bot.action('cancel_autopay', async (ctx) => {
      await ctx.answerCbQuery();
      await cancelAutopayHandler(ctx, pool);
    });

    const menuCommands = [
      { command: 'menu', description: msg('command_menu_desc') || 'Показать меню' },
      { command: 'demo', description: msg('command_demo_desc') || 'Демо-план' },
      { command: 'help', description: msg('command_help_desc') || 'Помощь' },
      { command: 'subscribe', description: msg('command_subscribe_desc') || 'Подписка и оплата' },
      { command: 'support', description: msg('command_support_desc') || 'Поддержка' },
    ];
    await bot.telegram.setMyCommands(menuCommands);
    await bot.telegram.setMyCommands(menuCommands, { language_code: 'ru' });
    await bot.telegram.setMyCommands(menuCommands, { scope: { type: 'all_private_chats' } });
    await bot.telegram.setMyCommands(menuCommands, {
      scope: { type: 'all_private_chats' },
      language_code: 'ru',
    });
    const qaChatIds = String(process.env.QA_INTAKE_CHAT_ID || '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
    if (qaChatIds.length) {
      const qaMenuCommands = [
        ...menuCommands,
        { command: 'qa', description: msg('command_qa_desc') || 'QA intake' },
      ];
      for (const chatIdRaw of qaChatIds) {
        const chatId = Number(chatIdRaw);
        if (!Number.isFinite(chatId)) continue;
        await bot.telegram.setMyCommands(qaMenuCommands, {
          scope: { type: 'chat', chat_id: chatId },
          language_code: 'ru',
        });
      }
    }
    await bot.launch();
    await reminderScheduler.start();
    await overdueNotifier.start();
    await paywallReminderScheduler.start();
    await betaFollowupScheduler.start();
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
  paywallReminderScheduler.stop();
  betaFollowupScheduler.stop();
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
  const metricsToken = process.env.BOT_METRICS_TOKEN || process.env.METRICS_TOKEN;
  metricsServer = http.createServer(async (req, res) => {
    if (req.url === '/metrics') {
      if (metricsToken) {
        let token = req.headers['x-metrics-token'] || '';
        if (!token) {
          const auth = req.headers.authorization || '';
          if (auth.toLowerCase().startsWith('bearer ')) {
            token = auth.slice(7).trim();
          }
        }
        if (token !== metricsToken) {
          res.statusCode = 401;
          res.end('unauthorized');
          return;
        }
      }
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
