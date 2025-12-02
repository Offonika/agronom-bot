const crypto = require('node:crypto');
const { msg } = require('./utils');
const { dict } = require('./i18n');
const {
  buildAssistantText,
  buildKeyboardLayout,
  detectFaqIntent,
  formatFaqAnswer,
  resolveFollowupReply,
} = require('./messageFormatters/diagnosisMessage');
const { logFunnelEvent } = require('./funnel');
const { sendPaywall } = require('./payments');

const PRODUCT_NAMES_MAX = 100;
const productNames = new Map();
const MAX_DIAG_HISTORY = 200;
const lastDiagnoses = new Map();
const MAX_CROP_HINTS = 500;
const cropHints = new Map();
const STRING_MIN_MATCH = 3;
const PLAN_BINDING_SOURCE = 'ai';
const PROGRESS_KEYS = {
  downloading: 'photo_progress_downloading',
  analyzing: 'photo_progress_analyzing',
  pending: 'photo_progress_pending',
  ready: 'photo_progress_ready',
  failed: 'photo_progress_failed',
};

function normalizeText(value) {
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

function normalizeCrop(value) {
  const text = normalizeText(value);
  return text ? text.toLowerCase() : '';
}

function cropsMatch(a, b) {
  if (!a || !b) return false;
  return normalizeCrop(a) === normalizeCrop(b);
}

function nameMatchesCrop(name, cropKey) {
  const normName = normalizeCrop(name);
  if (!normName || !cropKey || cropKey.length < STRING_MIN_MATCH) return false;
  return normName.includes(cropKey);
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

async function resolveObjectForDiagnosis(db, user, payload) {
  if (!db || !user?.id || !payload) return null;
  if (typeof db.listObjects !== 'function') return null;
  const cropKey = normalizeCrop(payload.crop || payload.crop_ru);
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
  if (cropKey) {
    candidate =
      objects.find((obj) => cropsMatch(obj.type, cropKey)) ||
      objects.find((obj) => nameMatchesCrop(obj.name, cropKey));
  }
  if (!candidate && cropKey) {
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
  if (!candidate && user.last_object_id) {
    candidate = objects.find((obj) => Number(obj.id) === Number(user.last_object_id));
  }
  if (!candidate && objects.length) {
    candidate = objects[0];
  }
  if (candidate && typeof db.updateUserLastObject === 'function') {
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

async function persistRecentDiagnosis(deps, userId, payload, existingUser = null) {
  if (!deps?.db?.saveRecentDiagnosis || !userId || !payload) return null;
  try {
    const user = existingUser || (await deps.db.ensureUser(userId));
    const object = await resolveObjectForDiagnosis(deps.db, user, payload);
    const objectId = object?.id || user?.last_object_id || null;
    if (objectId) {
      payload.object_id = objectId;
    }
    const record = await deps.db.saveRecentDiagnosis({
      userId: user.id,
      objectId,
      payload,
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
const API_KEY = process.env.API_KEY || 'test-api-key';
const API_VER = process.env.API_VER || 'v1';
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

async function replyFollowupFromHistory(ctx, text) {
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
  await ctx.reply(answer);
  return true;
}

async function analyzePhoto(deps, ctx, photo) {
  if (!photo) return;
  const pool = deps?.pool;
  if (!pool) throw new Error('analyzePhoto requires pool in deps');
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
      dbUser = await dbClient.ensureUser(tgUserId);
    } catch (err) {
      console.error('ensureUser failed', err);
    }
  }
  const userId = dbUser?.id || tgUserId;
  if (dbUser) {
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
  }
  try {
    await pool.query(
      `INSERT INTO photos (user_id, file_id, file_unique_id, width, height, file_size, status)` +
      ` VALUES ($1, $2, $3, $4, $5, $6, 'pending')`,
      [userId, file_id, file_unique_id, width, height, file_size]
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

    console.log('Sending to API', API_BASE + '/v1/ai/diagnose');
    const apiResp = await fetch(API_BASE + '/v1/ai/diagnose', {
      method: 'POST',
      headers: {
        'X-API-Key': API_KEY,
        'X-API-Ver': API_VER,
        'X-User-ID': userId,
      },
      body: form,
    });
    if (apiResp.status === 402) {
      await sendPaywall(ctx, pool);
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
    rememberDiagnosis(userId, data);
    const recentRecord = await persistRecentDiagnosis(deps, userId, data, dbUser);
    const text = buildAssistantText(data);
    const keyboard = buildKeyboardLayout(data);
    if (data.protocol) {
      keyboard.inline_keyboard.unshift(buildProtocolRow(ctx, data.protocol));
    }
    await ctx.reply(text, { reply_markup: keyboard });
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
    }
  } catch (err) {
    console.error('diagnose error', err);
    if (typeof ctx.reply === 'function') {
      await ctx.reply(msg('diagnose_error'));
    }
    await progress.set(msg(PROGRESS_KEYS.failed) || null);
  }
}

async function messageHandler(ctx) {
  if (ctx.message?.photo) return;
  const text = ctx.message?.text;
  if (!text) {
    console.log('Ignoring non-text message');
    return;
  }
  if (await replyFollowupFromHistory(ctx, text)) {
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
      dbUser = await dbClient.ensureUser(ctx.from.id);
    } catch (err) {
      console.error('ensureUser failed', err);
    }
  }
  try {
    const resp = await fetch(`${API_BASE}/v1/photos/${photoId}`, {
      headers: {
        'X-API-Key': API_KEY,
        'X-API-Ver': API_VER,
        'X-User-ID': ctx.from?.id,
      },
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

    const userId = ctx.from?.id;
    rememberDiagnosis(userId, data);
    const recentRecord = await persistRecentDiagnosis(deps, userId, data, dbUser);
    const text = buildAssistantText(data);
    const keyboard = buildKeyboardLayout(data);
    if (data.protocol) {
      keyboard.inline_keyboard.unshift(buildProtocolRow(ctx, data.protocol));
    }
    await ctx.reply(text, { reply_markup: keyboard });
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
    return { pool: value };
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
  analyzePhoto,
};
