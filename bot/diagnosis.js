const crypto = require('node:crypto');
const { msg } = require('./utils');
const { dict } = require('./i18n');
const {
  buildAssistantText,
  buildKeyboardLayout,
  detectFaqIntent,
  formatFaqAnswer,
  resolveFollowupReply,
  LOW_CONFIDENCE_THRESHOLD,
} = require('./messageFormatters/diagnosisMessage');
const { logFunnelEvent } = require('./funnel');
const { buildApiHeaders } = require('./apiAuth');
const { createDb } = require('../services/db');
const { sendPaywall } = require('./payments');
const { ensureUserWithBeta, isBetaUser, logBetaEventOnce } = require('./beta');
const betaSurvey = require('./betaSurvey');
const { scheduleFollowup } = require('./betaFollowup');

const PRODUCT_NAMES_MAX = 100;
const productNames = new Map();
const MAX_DIAG_HISTORY = 200;
const lastDiagnoses = new Map();
const MAX_CROP_HINTS = 500;
const cropHints = new Map();
const STRING_MIN_MATCH = 3;
const DIAG_OBJECTS_MAX = 6;
const PLAN_BINDING_SOURCE = 'ai';
const MAX_TELEGRAM_MESSAGE = 3500;
const PROGRESS_KEYS = {
  downloading: 'photo_progress_downloading',
  analyzing: 'photo_progress_analyzing',
  pending: 'photo_progress_pending',
  ready: 'photo_progress_ready',
  failed: 'photo_progress_failed',
};

function resolveUtmForEvent(user) {
  const hasAny =
    user?.utm_source || user?.utm_medium || user?.utm_campaign;
  if (!hasAny) {
    return { utmSource: 'direct', utmMedium: 'organic', utmCampaign: null };
  }
  return {
    utmSource: user?.utm_source || null,
    utmMedium: user?.utm_medium || null,
    utmCampaign: user?.utm_campaign || null,
  };
}

function normalizeText(value) {
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

function splitTelegramMessage(text, maxLen = MAX_TELEGRAM_MESSAGE) {
  if (!text) return [''];
  const chunks = [];
  const paragraphs = text.split(/\n{2,}/);
  let current = '';
  const flush = () => {
    if (current) {
      chunks.push(current);
      current = '';
    }
  };
  const tryAppend = (piece, sep) => {
    const candidate = current ? `${current}${sep}${piece}` : piece;
    if (candidate.length <= maxLen) {
      current = candidate;
      return true;
    }
    return false;
  };
  const splitByLength = (value) => {
    for (let idx = 0; idx < value.length; idx += maxLen) {
      chunks.push(value.slice(idx, idx + maxLen));
    }
  };
  for (const para of paragraphs) {
    if (!para) continue;
    if (tryAppend(para, '\n\n')) continue;
    flush();
    if (para.length <= maxLen) {
      current = para;
      continue;
    }
    const lines = para.split('\n');
    let lineBuffer = '';
    for (const line of lines) {
      if (!line) continue;
      const candidate = lineBuffer ? `${lineBuffer}\n${line}` : line;
      if (candidate.length <= maxLen) {
        lineBuffer = candidate;
        continue;
      }
      if (lineBuffer) {
        chunks.push(lineBuffer);
        lineBuffer = '';
      }
      if (line.length <= maxLen) {
        lineBuffer = line;
        continue;
      }
      splitByLength(line);
    }
    if (lineBuffer) {
      chunks.push(lineBuffer);
    }
  }
  flush();
  return chunks.length ? chunks : [''];
}

function appendChannelLink(text) {
  const channel = msg('diagnosis.channel_follow');
  if (!channel) return text || '';
  if (!text) return channel;
  return `${text}\n\n${channel}`;
}

function normalizeCrop(value) {
  const text = normalizeText(value);
  return text ? text.toLowerCase() : '';
}

function cropsMatch(a, b) {
  if (!a || !b) return false;
  return normalizeCrop(a) === normalizeCrop(b);
}

function locationsMatch(a, b) {
  const normA = normalizeText(a).toLowerCase();
  const normB = normalizeText(b).toLowerCase();
  return normA && normB && normA === normB;
}

function nameMatchesCrop(name, cropKey) {
  const normName = normalizeCrop(name);
  if (!normName || !cropKey || cropKey.length < STRING_MIN_MATCH) return false;
  return normName.includes(cropKey);
}

function sanitizeObjectName(value, fallback) {
  const name = typeof value === 'string' ? value.trim() : '';
  return name || fallback || '';
}

function buildDiagnosisObjectPrompt(diagnosisId) {
  if (!diagnosisId) return null;
  return {
    inline_keyboard: [
      [{ text: msg('diag_object_create_button'), callback_data: `diag_object_create|${diagnosisId}` }],
      [{ text: msg('diag_object_choose_button'), callback_data: `diag_object_choose|${diagnosisId}` }],
    ],
  };
}

function buildDiagnosisObjectList(objects, diagnosisId) {
  if (!diagnosisId || !Array.isArray(objects) || !objects.length) return null;
  const buttons = objects.slice(0, DIAG_OBJECTS_MAX).map((obj) => [
    {
      text: sanitizeObjectName(obj?.name, msg('object.default_name')),
      callback_data: `diag_object_pick|${diagnosisId}|${obj.id}`,
    },
  ]);
  return { inline_keyboard: buttons };
}

function buildObjectMetaFromDiagnosis(payload, source = PLAN_BINDING_SOURCE) {
  const meta = { source };
  const variety = normalizeText(payload?.variety_ru || payload?.variety);
  if (variety) {
    meta.variety = variety;
  }
  const cropRu = normalizeText(payload?.crop_ru);
  if (cropRu) {
    meta.crop_ru = cropRu;
  }
  return meta;
}

async function maybeUpdateObjectMeta(db, object, payload) {
  if (!db?.updateObjectMeta || !object?.id) return object;
  const variety = normalizeText(payload?.variety_ru || payload?.variety);
  if (!variety) return object;
  const currentVariety = normalizeText(object.meta?.variety);
  if (currentVariety && normalizeCrop(currentVariety) === normalizeCrop(variety)) return object;
  try {
    const updated = await db.updateObjectMeta(object.id, { variety });
    return updated || object;
  } catch (err) {
    console.error('object meta update failed', err);
    return object;
  }
}

async function resolveObjectForDiagnosis(db, user, payload, options = {}) {
  if (!db || !user?.id || !payload) return null;
  if (typeof db.listObjects !== 'function') return null;
  const allowCreate = options.allowCreate !== false;
  const allowFallback = options.allowFallback !== false;
  const allowMatch = options.allowMatch !== false;
  const cropKey = normalizeCrop(payload.crop || payload.crop_ru);
  const cropRuKey = normalizeCrop(payload.crop_ru);
  const explicitObject = Boolean(payload.object_id);
  let objects = [];
  try {
    objects = (await db.listObjects(user.id)) || [];
  } catch (err) {
    console.error('listObjects failed', err);
  }
  const targetId = payload.object_id ? Number(payload.object_id) : null;
  const byId = targetId ? objects.find((obj) => Number(obj.id) === targetId) : null;
  if (byId) {
    return maybeUpdateObjectMeta(db, byId, payload);
  }
  let candidate = null;
  if (allowMatch && (cropKey || cropRuKey)) {
    const locationTag = normalizeText(payload.region || payload.location_tag);
    const matchesCrop = (value) => {
      if (!value) return false;
      const normValue = normalizeCrop(value);
      return (cropKey && normValue === cropKey) || (cropRuKey && normValue === cropRuKey);
    };
    candidate =
      (locationTag
        ? objects.find(
            (obj) =>
              matchesCrop(obj.type) && locationsMatch(obj.location_tag, locationTag),
          )
        : null) ||
      objects.find((obj) => matchesCrop(obj.type)) ||
      objects.find((obj) => nameMatchesCrop(obj.name, cropKey) || nameMatchesCrop(obj.name, cropRuKey));
  }
  if (!candidate && cropKey && objects.length === 0 && allowCreate) {
    const meta = buildObjectMetaFromDiagnosis(payload);
    try {
      candidate = await db.createObject(user.id, {
        name: payload.crop_ru || payload.crop || msg('object.default_name'),
        type: payload.crop || null,
        locationTag: payload.region || null,
        meta,
      });
    } catch (err) {
      console.error('createObject failed', err);
    }
    if (candidate) {
      objects.push(candidate);
    }
  }
  if (!candidate && user.last_object_id && allowFallback) {
    candidate = objects.find((obj) => Number(obj.id) === Number(user.last_object_id));
  }
  if (!candidate && objects.length && allowFallback) {
    candidate = objects[0];
  }
  const shouldUpdateLast =
    allowFallback && (explicitObject || objects.length <= 1 || (candidate && objects.length === 0));
  if (candidate && shouldUpdateLast && typeof db.updateUserLastObject === 'function') {
    try {
      await db.updateUserLastObject(user.id, candidate.id);
    } catch (err) {
      console.error('updateUserLastObject failed', err);
    }
  }
  return maybeUpdateObjectMeta(db, candidate, payload);
}

function cleanupProductNames() {
  if (productNames.size >= PRODUCT_NAMES_MAX) {
    const oldestKey = productNames.keys().next().value;
    if (oldestKey !== undefined) {
      productNames.delete(oldestKey);
    }
  }
}

function rememberDiagnosis(userId, payload) {
  if (!userId || !payload) return;
  if (!lastDiagnoses.has(userId) && lastDiagnoses.size >= MAX_DIAG_HISTORY) {
    const oldest = lastDiagnoses.keys().next().value;
    if (oldest !== undefined) {
      lastDiagnoses.delete(oldest);
    }
  }
  lastDiagnoses.set(userId, { data: payload, ts: Date.now() });
}

async function persistRecentDiagnosis(deps, userId, payload, existingUser = null, options = {}) {
  if (!deps?.db?.saveRecentDiagnosis || !userId || !payload) return null;
  try {
    const user = existingUser || (await deps.db.ensureUser(userId));
    const object = await resolveObjectForDiagnosis(deps.db, user, payload, options);
    const allowFallback = options.allowFallback !== false;
    const objectId = object?.id || (allowFallback ? user?.last_object_id : null);
    if (objectId) {
      payload.object_id = objectId;
    }
    const caseId = options.caseId || options.linkedCaseId || payload.case_id || null;
    const record = await deps.db.saveRecentDiagnosis({
      userId: user.id,
      objectId,
      payload,
      caseId,
    });
    if (record?.id) {
      payload.recent_diagnosis_id = record.id;
    }
    return record;
  } catch (err) {
    console.error('recent_diagnosis save failed', err);
    return null;
  }
}

function getLastDiagnosis(userId) {
  return lastDiagnoses.get(userId)?.data || null;
}

function setCropHint(userId, hint) {
  if (!userId || !hint) return;
  if (!cropHints.has(userId) && cropHints.size >= MAX_CROP_HINTS) {
    const oldest = cropHints.keys().next().value;
    if (oldest !== undefined) cropHints.delete(oldest);
  }
  cropHints.set(userId, hint);
}

function getCropHint(userId) {
  return userId ? cropHints.get(userId) : undefined;
}

function maskRawBody(body) {
  if (!body) return '';
  return String(body).replace(/\d{4,}/g, '[id]');
}

function createProgressTracker(ctx) {
  let messageId = null;
  let chatId = ctx?.chat?.id || ctx?.from?.id || null;
  let lastText = null;

  function capture(reply) {
    if (reply?.message_id) messageId = reply.message_id;
    if (reply?.chat?.id) chatId = reply.chat.id;
  }

  async function set(text) {
    if (!text || !messageId || !chatId) return;
    if (text === lastText) return;
    if (typeof ctx?.telegram?.editMessageText !== 'function') return;
    try {
      await ctx.telegram.editMessageText(chatId, messageId, undefined, text);
      lastText = text;
    } catch (err) {
      const desc = String(err?.description || '');
      if (!desc.includes('message is not modified')) {
        console.error('progress_edit_failed', err);
      }
    }
  }

  return { capture, set };
}

function buildParseErrorReply() {
  return {
    text: msg('diagnosis.parse_error'),
    reply_markup: {
      inline_keyboard: [[{ text: msg('cta.reshoot'), callback_data: 'reshoot_photo' }]],
    },
  };
}

async function ensureCaseForDiagnosis({
  db,
  user,
  diagnosis,
  recentRecord,
  linkedCaseId = null,
}) {
  if (!db || !user || !diagnosis) return null;
  const confidence = Number(diagnosis.confidence);
  if (!Number.isFinite(confidence) || confidence < LOW_CONFIDENCE_THRESHOLD) {
    return null;
  }
  let caseRow = null;
  const existingCaseId = linkedCaseId || diagnosis.case_id || recentRecord?.case_id;
  if (existingCaseId && typeof db.getCaseById === 'function') {
    try {
      const fetched = await db.getCaseById(existingCaseId);
      if (fetched && Number(fetched.user_id) === Number(user.id)) {
        caseRow = fetched;
      }
    } catch (err) {
      console.error('case fetch failed', err);
    }
  }
  if (!caseRow && existingCaseId && typeof db.getCaseById !== 'function') {
    caseRow = { id: existingCaseId, user_id: user.id };
  }
  if (!caseRow && typeof db.createCase === 'function') {
    try {
      caseRow = await db.createCase({
        user_id: user.id,
        object_id: recentRecord?.object_id || diagnosis.object_id || null,
        crop: diagnosis.crop,
        disease: diagnosis.disease,
        confidence: diagnosis.confidence,
        raw_ai: diagnosis,
      });
    } catch (err) {
      console.error('case create failed', err);
    }
  }
  if (caseRow?.id) {
    diagnosis.case_id = caseRow.id;
    if (recentRecord?.id && typeof db.linkRecentDiagnosisToPlan === 'function') {
      try {
        await db.linkRecentDiagnosisToPlan({
          diagnosisId: recentRecord.id,
          objectId: recentRecord.object_id || diagnosis.object_id || null,
          caseId: caseRow.id,
        });
      } catch (err) {
        console.error('recent_diagnosis link failed', err);
      }
    }
  }
  return caseRow;
}

async function handleBetaDiagnosis({ db, ctx, user, diagnosis, recentRecord, caseRow }) {
  if (!db || !ctx || !user || !diagnosis) return;
  if (!isBetaUser(user)) return;
  try {
    const resolved = caseRow || (await ensureCaseForDiagnosis({ db, user, diagnosis, recentRecord }));
    if (resolved?.id && typeof db.getBetaEvent === 'function' && typeof db.logBetaEvent === 'function') {
      const first = await db.getBetaEvent(user.id, 'beta_first_diagnosis');
      if (!first) {
        await db.logBetaEvent({
          userId: user.id,
          eventType: 'beta_first_diagnosis',
          payload: { case_id: resolved.id },
        });
        await scheduleFollowup(db, user.id, resolved.id);
        await betaSurvey.maybePromptSurvey({
          db,
          ctx,
          user,
          caseId: resolved.id,
        });
      }
    }
  } catch (err) {
    console.error('beta diagnosis handler failed', err);
  }
}

function buildProtocolRow(ctx, protocol) {
  const encode = (v) => encodeURIComponent(String(v ?? ''));
  const safeSlice = (str, max) => {
    if (str.length <= max) return str;
    let s = str.slice(0, max);
    const pct = s.lastIndexOf('%');
    if (pct > -1 && pct > s.length - 3) {
      s = s.slice(0, pct);
    }
    return s;
  };
  const product = protocol.product || '';
  let productHash = product;
  if (productHash.length > 32) {
    productHash = crypto.createHash('sha256').update(productHash).digest('hex');
  }
  const other = [encode(protocol.dosage_value), encode(protocol.dosage_unit), encode(protocol.phi)];
  const base = ['proto', '', ...other].join('|');
  const avail = 64 - base.length;
  const prodEncoded = safeSlice(encode(productHash), Math.max(avail, 0));
  cleanupProductNames();
  productNames.set(decodeURIComponent(prodEncoded), product);
  const callback = ['proto', prodEncoded, ...other].join('|').slice(0, 64);
  const row = [{ text: '📄 Показать протокол', callback_data: callback }];
  if (protocol.id) {
    const urlBase = process.env.PARTNER_LINK_BASE || 'https://agrostore.example/agronom';
    const uid = crypto.createHash('sha256').update(String(ctx.from?.id ?? 'anon')).digest('hex');
    const link = `${urlBase}?pid=${protocol.id}&src=bot&uid=${uid}&dis=5&utm_campaign=agrobot`;
    row.push({ text: '🛒 Купить препарат', url: link });
  }
  return row;
}

const API_BASE = process.env.API_BASE_URL || 'http://localhost:8010';
const MAX_FILE_SIZE = 2 * 1024 * 1024; // 2 MB

async function replyFaq(ctx, intentId) {
  if (!intentId) return false;
  const stored = getLastDiagnosis(ctx.from?.id);
  if (!stored) {
    await ctx.reply(msg('faq.no_context'));
    return false;
  }
  const answer = formatFaqAnswer(intentId, stored);
  if (!answer) {
    await ctx.reply(msg('faq.no_context'));
    return false;
  }
  await ctx.reply(answer);
  return true;
}

async function handleClarifySelection(ctx, optionId) {
  if (typeof ctx.answerCbQuery === 'function') {
    try {
      await ctx.answerCbQuery();
    } catch {
      // ignore answer errors
    }
  }
  const stored = getLastDiagnosis(ctx.from?.id);
  let optionLabel;
  let hintValue;
  if (stored?.clarify_crop_variants && Number.isInteger(Number(optionId))) {
    optionLabel = stored.clarify_crop_variants[Number(optionId)];
    hintValue = optionLabel;
  }
  if (!optionLabel) {
    const options = dict('clarify.crop.options');
    optionLabel = options[optionId];
    hintValue = optionId;
  }
  if (!optionLabel) {
    await ctx.reply(msg('diagnose_error'));
    return;
  }
  if (ctx.from?.id) {
    setCropHint(ctx.from.id, hintValue);
  }
  await ctx.reply(msg('clarify.crop.confirm', { crop: optionLabel }));
}

async function logAssistantCtaShown(deps, ctx) {
  const dbClient = deps?.db;
  const tgUserId = ctx?.from?.id;
  if (!dbClient?.logAnalyticsEvent || !tgUserId) return;
  let dbUser = null;
  try {
    dbUser = await ensureUserWithBeta(dbClient, tgUserId);
  } catch (err) {
    console.error('assistant_cta ensureUser failed', err);
    return;
  }
  if (!dbUser) return;
  const utm = resolveUtmForEvent(dbUser);
  try {
    await dbClient.logAnalyticsEvent({
      event: 'assistant_cta_shown',
      userId: dbUser.id,
      utmSource: utm.utmSource,
      utmMedium: utm.utmMedium,
      utmCampaign: utm.utmCampaign,
    });
  } catch (err) {
    console.error('assistant_cta log failed', err);
  }
}

async function replyFollowupFromHistory(ctx, text, deps = {}) {
  const normalized = typeof text === 'string' ? text.trim() : '';
  if (!normalized) return false;
  const stored = getLastDiagnosis(ctx.from?.id);
  if (!stored) {
    const keywordReply = resolveFollowupReply(null, normalized);
    if (!keywordReply) return false;
    await ctx.reply(msg('faq.no_context'));
    return true;
  }
  const answer = resolveFollowupReply(stored, normalized);
  if (!answer) return false;
  if (answer === msg('followup_default')) {
    const assistantCta = msg('cta.ask_assistant');
    const opts = assistantCta
      ? { reply_markup: { inline_keyboard: [[{ text: assistantCta, callback_data: 'assistant_entry' }]] } }
      : undefined;
    await ctx.reply(answer, opts);
    await logAssistantCtaShown(deps, ctx);
    return true;
  }
  await ctx.reply(answer);
  return true;
}

async function analyzePhoto(deps, ctx, photo, options = {}) {
  if (!photo) return;
  const pool = deps?.pool;
  if (!pool) throw new Error('analyzePhoto requires pool in deps');
  const linkedCaseId = options.linkedCaseId || null;
  const { file_id, file_unique_id, width, height, file_size } = photo;
  if (file_size > MAX_FILE_SIZE) {
    if (typeof ctx.reply === 'function') {
      await ctx.reply(msg('photo_too_large'));
    }
    return;
  }
  const tgUserId = ctx.from?.id;
  if (!tgUserId) return;
  const dbClient = deps?.db;
  let dbUser = null;
  if (dbClient?.ensureUser) {
    try {
      dbUser = await ensureUserWithBeta(dbClient, tgUserId);
    } catch (err) {
      console.error('ensureUser failed', err);
    }
  }
  if (!dbUser?.api_key) {
    if (typeof ctx.reply === 'function') {
      await ctx.reply(msg('diagnose_error'));
    }
    return;
  }
  const dbUserId = dbUser.id;
  if (dbUser) {
    if (typeof dbClient?.logAnalyticsEvent === 'function') {
      try {
        const utm = resolveUtmForEvent(dbUser);
        await dbClient.logAnalyticsEvent({
          event: 'photo_sent',
          userId: dbUser.id,
          utmSource: utm.utmSource,
          utmMedium: utm.utmMedium,
          utmCampaign: utm.utmCampaign,
        });
      } catch (err) {
        console.error('photo_sent log failed', err);
      }
    }
    await logFunnelEvent(dbClient, {
      event: 'photo_received',
      userId: dbUser.id,
      objectId: dbUser.last_object_id || null,
      data: {
        file_size,
        width,
        height,
      },
    });
    if (isBetaUser(dbUser)) {
      await logBetaEventOnce(dbClient, dbUser.id, 'beta_photo_sent', {
        file_size,
        width,
        height,
      });
    }
  }
  try {
    await pool.query(
      `INSERT INTO photos (user_id, file_id, file_unique_id, width, height, file_size, status)` +
      ` VALUES ($1, $2, $3, $4, $5, $6, 'pending')`,
      [dbUserId, file_id, file_unique_id, width, height, file_size]
    );
  } catch (err) {
    console.error('DB insert error', err);
    if (typeof ctx.reply === 'function') {
      await ctx.reply(msg('db_error'));
    }
    return;
  }

  const progress = createProgressTracker(ctx);

  if (typeof ctx.reply === 'function') {
    const initial = await ctx.reply(msg('photo_processing'));
    progress.capture(initial);
    await progress.set(msg(PROGRESS_KEYS.downloading) || null);
  }

  try {
    const link = await ctx.telegram.getFileLink(file_id);
    console.log('Downloading photo from', link.href);
    const res = await fetch(link.href);
    if (!res.ok) {
      console.error('Photo download error', res.status);
      if (typeof ctx.reply === 'function') {
        await ctx.reply(msg('diagnose_error'));
      }
      await progress.set(msg(PROGRESS_KEYS.failed) || null);
      return;
    }
    const form = new FormData();
    let buffer;
    if (typeof res.arrayBuffer === 'function') {
      buffer = Buffer.from(await res.arrayBuffer());
    } else {
      const chunks = [];
      for await (const chunk of res.body ?? []) {
        chunks.push(Buffer.from(chunk));
      }
      buffer = Buffer.concat(chunks);
    }
    await progress.set(msg(PROGRESS_KEYS.analyzing) || null);
    const blob = new Blob([buffer], { type: 'image/jpeg' });
    form.append('image', blob, 'photo.jpg');
    const cropHint = getCropHint(tgUserId);
    if (cropHint) {
      console.log('Applying crop hint', cropHint);
      form.append('crop_hint', cropHint);
    }
    if (linkedCaseId) {
      form.append('case_id', String(linkedCaseId));
    }

    console.log('Sending to API', API_BASE + '/v1/ai/diagnose');
    const apiResp = await fetch(API_BASE + '/v1/ai/diagnose', {
      method: 'POST',
      headers: buildApiHeaders({
        apiKey: dbUser.api_key,
        userId: dbUserId,
        method: 'POST',
        path: '/v1/ai/diagnose',
      }),
      body: form,
    });
    if (apiResp.status === 402) {
      let info = null;
      try {
        info = await apiResp.json();
      } catch (err) {
        console.error('Failed to parse paywall response', err);
      }
      await sendPaywall(ctx, pool, info || {});
      await progress.set(msg(PROGRESS_KEYS.failed) || null);
      return;
    }
    if (!apiResp.ok) {
      console.error('API error status', apiResp.status);
      let errCode;
      try {
        const errData = await apiResp.json();
        errCode = errData?.code;
      } catch (err) {
        console.error('Failed to parse API error response', err);
      }
      if (typeof ctx.reply === 'function') {
        if (errCode) {
          await ctx.reply(msg('error_' + errCode));
        } else {
          await ctx.reply(msg('diagnose_error'));
        }
      }
      await progress.set(msg(PROGRESS_KEYS.failed) || null);
      return;
    }
    const rawBody = await apiResp.text();
    console.debug('Diagnose raw body', maskRawBody(rawBody).slice(0, 1000));
    let data;
    try {
      data = JSON.parse(rawBody);
    } catch (err) {
      console.error('Failed to parse API response', err);
      if (typeof ctx.reply === 'function') {
        const parseReply = buildParseErrorReply();
        await ctx.reply(parseReply.text, { reply_markup: parseReply.reply_markup });
      }
      await progress.set(msg(PROGRESS_KEYS.failed) || null);
      return;
    }
    console.log('API response', data);
    if (linkedCaseId) {
      data.case_id = linkedCaseId;
    }

    if (data.status === 'pending') {
      const cb = `retry|${encodeURIComponent(String(data.id))}`.slice(0, 64);
      await progress.set(msg(PROGRESS_KEYS.pending) || null);
      await ctx.reply(msg('diag_pending'), {
        reply_markup: {
          inline_keyboard: [[{ text: msg('retry_button'), callback_data: cb }]],
        },
      });
      return;
    }

    await progress.set(msg(PROGRESS_KEYS.ready) || null);
    rememberDiagnosis(tgUserId, data);
    let needsObjectChoice = false;
    if (dbUser && typeof dbClient?.listObjects === 'function' && !data.object_id) {
      try {
        const objects = await dbClient.listObjects(dbUser.id);
        if (Array.isArray(objects) && objects.length) {
          needsObjectChoice = true;
          data.require_object_choice = true;
        }
      } catch (err) {
        console.error('listObjects failed', err);
      }
    }
    const recentRecord = await persistRecentDiagnosis(
      deps,
      tgUserId,
      data,
      dbUser,
      needsObjectChoice
        ? { allowCreate: false, allowFallback: false, allowMatch: false, caseId: linkedCaseId }
        : { caseId: linkedCaseId },
    );
    const text = appendChannelLink(buildAssistantText(data));
    const keyboard = buildKeyboardLayout(data);
    if (data.protocol) {
      keyboard.inline_keyboard.unshift(buildProtocolRow(ctx, data.protocol));
    }
    const chunks = splitTelegramMessage(text);
    for (let i = 0; i < chunks.length; i += 1) {
      const isLast = i === chunks.length - 1;
      const options = isLast ? { reply_markup: keyboard } : undefined;
      await ctx.reply(chunks[i], options);
    }
    if (needsObjectChoice && recentRecord?.id && typeof ctx.reply === 'function') {
      const promptKeyboard = buildDiagnosisObjectPrompt(recentRecord.id);
      if (promptKeyboard) {
        await ctx.reply(msg('diag_object_prompt'), { reply_markup: promptKeyboard });
      }
    }
    if (dbUser) {
      await logFunnelEvent(dbClient, {
        event: 'diagnosis_shown',
        userId: dbUser.id,
        objectId: recentRecord?.object_id || dbUser.last_object_id || null,
        data: {
          crop: data.crop || null,
          confidence: data.confidence ?? null,
        },
      });
      const caseRow = await ensureCaseForDiagnosis({
        db: dbClient,
        user: dbUser,
        diagnosis: data,
        recentRecord,
        linkedCaseId,
      });
      await handleBetaDiagnosis({
        db: dbClient,
        ctx,
        user: dbUser,
        diagnosis: data,
        recentRecord,
        caseRow,
      });
    }
  } catch (err) {
    console.error('diagnose error', err);
    if (typeof ctx.reply === 'function') {
      await ctx.reply(msg('diagnose_error'));
    }
    await progress.set(msg(PROGRESS_KEYS.failed) || null);
  }
}

async function messageHandler(arg1, arg2) {
  let ctx;
  let deps = {};
  if (arg1 && typeof arg1.reply === 'function') {
    ctx = arg1;
  } else {
    deps = normalizeDeps(arg1);
    ctx = arg2;
  }
  if (!ctx) return;
  if (ctx.message?.photo) return;
  const text = ctx.message?.text;
  if (!text) {
    console.log('Ignoring non-text message');
    return;
  }
  if (await replyFollowupFromHistory(ctx, text, deps)) {
    return;
  }
  const intent = detectFaqIntent(text);
  if (intent) {
    await replyFaq(ctx, intent);
    return;
  }
  console.log('Ignoring message without intent');
}

async function retryHandler(arg1, arg2, arg3) {
  let ctx;
  let photoId;
  let deps;
  if (arg1 && typeof arg1.reply === 'function') {
    ctx = arg1;
    photoId = arg2;
    deps = normalizeDeps(arg3);
  } else {
    deps = normalizeDeps(arg1);
    ctx = arg2;
    photoId = arg3;
  }
  const dbClient = deps?.db;
  let dbUser = null;
  if (dbClient?.ensureUser && ctx.from?.id) {
    try {
      dbUser = await ensureUserWithBeta(dbClient, ctx.from.id);
    } catch (err) {
      console.error('ensureUser failed', err);
    }
  }
  if (!dbUser?.api_key) {
    await ctx.reply(msg('status_error'));
    return;
  }
  const tgUserId = ctx.from?.id;
  const dbUserId = dbUser.id;
  try {
    const resp = await fetch(`${API_BASE}/v1/photos/${photoId}`, {
      headers: buildApiHeaders({
        apiKey: dbUser.api_key,
        userId: dbUserId,
        method: 'GET',
        path: `/v1/photos/${photoId}`,
      }),
    });
    if (!resp.ok) {
      await ctx.reply(msg('status_error'));
      return;
    }
    const data = await resp.json();
    if (data.status === 'pending' || data.status === 'retrying') {
      const cb = `retry|${encodeURIComponent(String(photoId))}`.slice(0, 64);
      await ctx.reply(msg('diag_pending'), {
        reply_markup: {
          inline_keyboard: [[{ text: msg('retry_button'), callback_data: cb }]],
        },
      });
      return;
    }

    rememberDiagnosis(tgUserId, data);
    let needsObjectChoice = false;
    if (dbUser && typeof dbClient?.listObjects === 'function' && !data.object_id) {
      try {
        const objects = await dbClient.listObjects(dbUser.id);
        if (Array.isArray(objects) && objects.length) {
          needsObjectChoice = true;
          data.require_object_choice = true;
        }
      } catch (err) {
        console.error('listObjects failed', err);
      }
    }
    const recentRecord = await persistRecentDiagnosis(
      deps,
      tgUserId,
      data,
      dbUser,
      needsObjectChoice ? { allowCreate: false, allowFallback: false } : undefined,
    );
    const text = appendChannelLink(buildAssistantText(data));
    const keyboard = buildKeyboardLayout(data);
    if (data.protocol) {
      keyboard.inline_keyboard.unshift(buildProtocolRow(ctx, data.protocol));
    }
    await ctx.reply(text, { reply_markup: keyboard });
    if (needsObjectChoice && recentRecord?.id) {
      const promptKeyboard = buildDiagnosisObjectPrompt(recentRecord.id);
      if (promptKeyboard) {
        await ctx.reply(msg('diag_object_prompt'), { reply_markup: promptKeyboard });
      }
    }
    if (dbUser) {
      await logFunnelEvent(dbClient, {
        event: 'diagnosis_shown',
        userId: dbUser.id,
        objectId: recentRecord?.object_id || dbUser.last_object_id || null,
        data: {
          crop: data.crop || null,
          confidence: data.confidence ?? null,
          source: 'retry',
        },
      });
      const caseRow = await ensureCaseForDiagnosis({
        db: dbClient,
        user: dbUser,
        diagnosis: data,
        recentRecord,
      });
      await handleBetaDiagnosis({
        db: dbClient,
        ctx,
        user: dbUser,
        diagnosis: data,
        recentRecord,
        caseRow,
      });
    }
  } catch (err) {
    console.error('retry error', err);
    await ctx.reply(msg('status_error'));
  }
}

function getProductName(hash) {
  return productNames.get(hash);
}

function normalizeDeps(value) {
  if (value && typeof value.query === 'function') {
    if (typeof value.ensureUser === 'function') {
      return { pool: value, db: value };
    }
    let pool = value;
    if (typeof value.connect !== 'function' || typeof value.end !== 'function') {
      pool = {
        ...value,
        connect: async () => value,
        end: async () => {},
      };
    }
    let db = null;
    try {
      db = createDb(pool);
    } catch (err) {
      console.error('createDb failed', err);
    }
    return { pool: value, db };
  }
  if (value?.pool && !value.db && typeof value.pool.query === 'function') {
    const pool = value.pool;
    if (typeof pool.ensureUser === 'function') {
      return { ...value, db: pool };
    }
    let wrapped = pool;
    if (typeof pool.connect !== 'function' || typeof pool.end !== 'function') {
      wrapped = {
        ...pool,
        connect: async () => pool,
        end: async () => {},
      };
    }
    try {
      const db = createDb(wrapped);
      return { ...value, db };
    } catch (err) {
      console.error('createDb failed', err);
    }
  }
  return value || {};
}

module.exports = {
  photoHandler: async (depsOrPool, ctx) => {
    const deps = normalizeDeps(depsOrPool);
    const photo = ctx?.message?.photo?.[ctx.message.photo.length - 1];
    return analyzePhoto(deps, ctx, photo);
  },
  messageHandler,
  retryHandler,
  getProductName,
  replyFaq,
  handleClarifySelection,
  rememberDiagnosis,
  getLastDiagnosis,
  getCropHint,
  buildProtocolRow,
  buildDiagnosisObjectList,
  analyzePhoto,
};
