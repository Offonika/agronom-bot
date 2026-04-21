'use strict';

const crypto = require('crypto');
const { msg, sanitizeObjectName } = require('./utils');
const { buildApiHeaders } = require('./apiAuth');
const { ensureUserWithBeta, isBetaUser } = require('./beta');
const { getLastDiagnosis } = require('./diagnosis');
const { replyUserError, USER_ERROR_CODES } = require('./userErrors');
const { sendAssistantPaywall } = require('./payments');

const API_BASE = process.env.API_BASE_URL || 'http://localhost:8010';
const SESSION_TTL_MS = Number(process.env.ASSISTANT_SESSION_TTL_MS || `${10 * 60 * 1000}`);
const START_THROTTLE_MS = Number(process.env.ASSISTANT_START_THROTTLE_MS || '1500');
const CONTEXT_TTL_MS = Number(process.env.ASSISTANT_CONTEXT_TTL_MS || `${24 * 60 * 60 * 1000}`);
let CHAT_TIMEOUT_MS = Number(process.env.ASSISTANT_CHAT_TIMEOUT_MS || `${120 * 1000}`);
if (!Number.isFinite(CHAT_TIMEOUT_MS) || CHAT_TIMEOUT_MS <= 0) {
  CHAT_TIMEOUT_MS = 120 * 1000;
}
let TYPING_INTERVAL_MS = Number(process.env.ASSISTANT_TYPING_INTERVAL_MS || '4500');
if (!Number.isFinite(TYPING_INTERVAL_MS) || TYPING_INTERVAL_MS <= 0) {
  TYPING_INTERVAL_MS = 4500;
}
const MAX_FOLLOWUPS = 3;
const BODY_LOG_LIMIT = 500;
const CONFIRM_DEDUP_MS = Number(process.env.ASSISTANT_CONFIRM_DEDUP_MS || '120000');
const SHORT_REPLY_WINDOW_MS = Number(process.env.ASSISTANT_SHORT_REPLY_WINDOW_MS || '120000');
const HISTORY_MAX_ITEMS = Number(process.env.ASSISTANT_HISTORY_MAX_ITEMS || '8');
const HISTORY_MAX_TEXT = Number(process.env.ASSISTANT_HISTORY_MAX_TEXT || '320');
const SESSION_EXPIRED_GRACE_MS = Number(process.env.ASSISTANT_SESSION_EXPIRED_GRACE_MS || '300000');
const REDIS_KEY_PREFIX = process.env.ASSISTANT_SESSION_REDIS_PREFIX || 'bot:assistant_session:';
const QUESTION_PREFIX_RE =
  /^(как|что|почему|зачем|когда|где|сколько|какой|какая|какие|чем|чего|куда|отчего|можно|нужно|стоит|подскаж|посовет|помоги)\b/i;
const SHORT_ACK_RE =
  /^(да|нет|ок|окей|okay|ok|угу|ага|спасибо|спс|понял|понятно|ясно|хорошо|ладно)([.!?]+)?$/i;
const SHORT_PUNCT_RE = /^[!?]+$/;
const PUNCT_ONLY_RE = /^[\s!?.,;:]+$/;
const TOPIC_PATTERNS = [
  { key: 'grape', pattern: /(виноград|сусло|брожени|винодел|brix|дрожж|вино|pH)/i },
  { key: 'tomato', pattern: /(томат)/i },
  { key: 'apple', pattern: /(яблон|яблок)/i },
  {
    key: 'indoor',
    pattern: /(комнатн|драцена|фикус|орхиде|монстер|спатифиллум|суккулент|кактус)/i,
  },
];
const TOPIC_ALIASES = {
  grape: ['grape', 'vine', 'vinograd'],
  tomato: ['tomato', 'tomat'],
  apple: ['apple', 'apples'],
  indoor: ['indoor', 'houseplant', 'room', 'комнат'],
};
const TOPIC_LABELS = {
  grape: 'виноград',
  tomato: 'томат',
  apple: 'яблоня',
  indoor: 'комнатные растения',
};

function createAssistantChat({ db, pool, redis = null, sessionKeyPrefix = REDIS_KEY_PREFIX } = {}) {
  if (!db) {
    throw new Error('assistantChat requires db');
  }
  const sessions = new Map();
  const confirmCache = new Map();
  const redisClient = redis || null;
  const redisKeyPrefix =
    typeof sessionKeyPrefix === 'string' && sessionKeyPrefix.trim()
      ? sessionKeyPrefix.trim()
      : REDIS_KEY_PREFIX;
  const historyItemsLimit = Number.isFinite(HISTORY_MAX_ITEMS)
    ? Math.min(Math.max(Math.round(HISTORY_MAX_ITEMS), 2), 24)
    : 8;
  const historyTextLimit = Number.isFinite(HISTORY_MAX_TEXT)
    ? Math.min(Math.max(Math.round(HISTORY_MAX_TEXT), 64), 1000)
    : 320;

  function now() {
    return Date.now();
  }

  function toSessionKey(tgUserId) {
    const id = Number(tgUserId);
    if (!Number.isFinite(id) || id <= 0) return null;
    return String(id);
  }

  function __getSessions() {
    return sessions;
  }

  function getRedisKey(tgUserId) {
    const key = toSessionKey(tgUserId);
    if (!key) return null;
    return `${redisKeyPrefix}${key}`;
  }

  function startTypingLoop(ctx) {
    const chatId = ctx?.chat?.id;
    if (!chatId) return () => {};
    const intervalMs = Math.max(2500, Number.isFinite(TYPING_INTERVAL_MS) ? TYPING_INTERVAL_MS : 4500);
    let stopped = false;

    async function sendOnce() {
      if (stopped) return;
      try {
        if (typeof ctx.sendChatAction === 'function') {
          await ctx.sendChatAction('typing');
          return;
        }
        if (ctx.telegram?.sendChatAction) {
          await ctx.telegram.sendChatAction(chatId, 'typing');
        }
      } catch {
        // ignore chat action failures
      }
    }

    // Fire once immediately to show "typing..." quickly, then keep-alive.
    void sendOnce();
    const timer = setInterval(() => void sendOnce(), intervalMs);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }

  function generateSessionId() {
    if (typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
    return crypto.randomBytes(16).toString('hex');
  }

  function isExpired(session) {
    const anchor = session?.lastActiveAt || session?.startedAt;
    if (!anchor) return true;
    return now() - anchor > SESSION_TTL_MS;
  }

  function restoreSession(raw, tgUserId = null) {
    if (!raw || typeof raw !== 'object') return null;
    const normalized = {
      sessionId: raw.sessionId || generateSessionId(),
      startedAt: Number(raw.startedAt) || now(),
      lastActiveAt: Number(raw.lastActiveAt) || Number(raw.startedAt) || now(),
      objectId: raw.objectId ? Number(raw.objectId) || null : null,
      pendingProposalId: raw.pendingProposalId ? String(raw.pendingProposalId) : null,
      pendingMessage: typeof raw.pendingMessage === 'string' ? raw.pendingMessage : null,
      pendingTopic: typeof raw.pendingTopic === 'string' ? raw.pendingTopic : null,
      history: normalizeHistory(raw.history),
      recentDiagnosisId: raw.recentDiagnosisId ? Number(raw.recentDiagnosisId) || null : null,
      lastStartAt: Number(raw.lastStartAt) || null,
      lastAssistantReplyAt: Number(raw.lastAssistantReplyAt) || null,
      tgUserId: toSessionKey(tgUserId),
    };
    return isExpired(normalized) ? null : normalized;
  }

  async function persistSession(tgUserId, session) {
    if (!redisClient) return;
    const key = getRedisKey(tgUserId);
    if (!key) return;
    if (!session) {
      try {
        await redisClient.del(key);
      } catch (err) {
        console.error('assistant.session persist delete failed', err);
      }
      return;
    }
    const anchor = Number(session.lastActiveAt || session.startedAt || now());
    const ttlMs = Math.max(1000, anchor + SESSION_TTL_MS - now() + SESSION_EXPIRED_GRACE_MS);
    try {
      await redisClient.set(key, JSON.stringify(session), 'PX', ttlMs);
    } catch (err) {
      console.error('assistant.session persist set failed', err);
    }
  }

  async function hydrateSession(tgUserId) {
    const key = toSessionKey(tgUserId);
    if (!key) return null;
    const session = sessions.get(key);
    if (session && !isExpired(session)) return session;
    if (isExpired(session)) {
      sessions.delete(key);
    }
    if (!redisClient) return null;
    const redisKey = getRedisKey(tgUserId);
    if (!redisKey) return null;
    try {
      const raw = await redisClient.get(redisKey);
      if (!raw) return null;
      const restored = restoreSession(JSON.parse(raw), tgUserId);
      if (!restored) {
        await redisClient.del(redisKey);
        return null;
      }
      sessions.set(key, restored);
      return restored;
    } catch (err) {
      console.error('assistant.session hydrate failed', err);
      return null;
    }
  }

  async function getSession(tgUserId) {
    return hydrateSession(tgUserId);
  }

  async function saveSession(tgUserId, patch = {}) {
    const key = toSessionKey(tgUserId);
    if (!key) {
      return {
        sessionId: generateSessionId(),
        startedAt: now(),
        lastActiveAt: now(),
        objectId: null,
        pendingProposalId: null,
        pendingMessage: null,
        pendingTopic: null,
        history: [],
        ...patch,
      };
    }
    const current = (await hydrateSession(tgUserId)) || {
      sessionId: generateSessionId(),
      startedAt: now(),
      lastActiveAt: now(),
      objectId: null,
      pendingProposalId: null,
      pendingMessage: null,
      pendingTopic: null,
      history: [],
    };
    const next = { ...current, ...patch };
    next.lastActiveAt = now();
    sessions.set(key, next);
    await persistSession(tgUserId, next);
    return next;
  }

  function normalizeHistory(history) {
    if (!Array.isArray(history) || !history.length) return [];
    const cleaned = [];
    for (const item of history) {
      if (!item || typeof item !== 'object') continue;
      const roleRaw = typeof item.role === 'string' ? item.role.trim().toLowerCase() : '';
      const role = roleRaw === 'assistant' ? 'assistant' : roleRaw === 'user' ? 'user' : '';
      if (!role) continue;
      const textRaw = typeof item.text === 'string' ? item.text.trim() : '';
      if (!textRaw) continue;
      cleaned.push({
        role,
        text: textRaw.slice(0, historyTextLimit),
      });
      if (cleaned.length >= historyItemsLimit) break;
    }
    if (cleaned.length <= historyItemsLimit) return cleaned;
    return cleaned.slice(-historyItemsLimit);
  }

  function appendHistory(history, role, text) {
    const roleValue = role === 'assistant' ? 'assistant' : role === 'user' ? 'user' : '';
    const textValue = typeof text === 'string' ? text.trim() : '';
    if (!roleValue || !textValue) {
      return normalizeHistory(history);
    }
    const base = normalizeHistory(history);
    base.push({ role: roleValue, text: textValue.slice(0, historyTextLimit) });
    if (base.length > historyItemsLimit) {
      return base.slice(-historyItemsLimit);
    }
    return base;
  }

  async function deleteSession(tgUserId) {
    const key = toSessionKey(tgUserId);
    if (!key) return false;
    const deleted = sessions.delete(key);
    await persistSession(tgUserId, null);
    return deleted;
  }

  function getConfirmKey(userId, proposalId, objectId) {
    return `${userId}:${proposalId}:${objectId || ''}`;
  }

  function isConfirmDuplicate(key) {
    const entry = confirmCache.get(key);
    if (!entry) return false;
    if (now() - entry.ts > CONFIRM_DEDUP_MS) {
      confirmCache.delete(key);
      return false;
    }
    return true;
  }

  function looksLikeQuestion(text) {
    const normalized = typeof text === 'string' ? text.trim() : '';
    if (!normalized) return false;
    if (normalized.includes('?')) return true;
    return QUESTION_PREFIX_RE.test(normalized);
  }

  function isShortAck(text) {
    const normalized = typeof text === 'string' ? text.trim() : '';
    if (!normalized) return false;
    if (normalized.length > 16) return false;
    return SHORT_ACK_RE.test(normalized) || SHORT_PUNCT_RE.test(normalized);
  }

  function isPunctuationOnly(text) {
    const normalized = typeof text === 'string' ? text.trim() : '';
    if (!normalized) return false;
    return PUNCT_ONLY_RE.test(normalized);
  }

  function detectTopic(text) {
    if (!text) return null;
    for (const entry of TOPIC_PATTERNS) {
      if (entry.pattern.test(text)) return entry.key;
    }
    return null;
  }

  function normalizeTopic(value) {
    if (!value) return null;
    const raw = String(value).toLowerCase();
    for (const [key, aliases] of Object.entries(TOPIC_ALIASES)) {
      if (aliases.some((alias) => raw.includes(alias))) {
        return key;
      }
    }
    return detectTopic(raw);
  }

  function topicLabel(key) {
    return TOPIC_LABELS[key] || key || '';
  }

  function extractDiagnosisTopic(payload) {
    if (!payload) return null;
    return (
      normalizeTopic(payload?.crop) ||
      detectTopic(payload?.crop_ru) ||
      detectTopic(payload?.disease) ||
      detectTopic(payload?.disease_name_ru)
    );
  }

  function parseDate(value) {
    if (!value) return null;
    const dt = new Date(value);
    if (Number.isNaN(dt.getTime())) return null;
    return dt.getTime();
  }

  function isRecentRecord(record) {
    if (!record) return false;
    const nowTs = now();
    const expiresAt = parseDate(record.expires_at);
    if (expiresAt !== null) {
      return expiresAt > nowTs;
    }
    const createdAt = parseDate(record.created_at);
    if (createdAt !== null) {
      return nowTs - createdAt <= CONTEXT_TTL_MS;
    }
    return false;
  }

  async function getLatestRecentRecord(userId) {
    if (!userId || typeof db.getLatestRecentDiagnosis !== 'function') return null;
    try {
      const record = await db.getLatestRecentDiagnosis(userId);
      if (!record || !isRecentRecord(record)) return null;
      return record;
    } catch (err) {
      console.error('assistant.latestRecent fetch failed', err);
      return null;
    }
  }

  function buildContextMismatchKeyboard() {
    const rows = [];
    rows.push([
      {
        text: msg('assistant.choose_object_button') || '🪴 Выбрать растение',
        callback_data: 'assistant_choose_object',
      },
    ]);
    rows.push([
      {
        text: msg('assistant.continue_without_object_button') || '➡️ Продолжить без привязки',
        callback_data: 'assistant_clear_context',
      },
    ]);
    return { inline_keyboard: rows };
  }

  async function resolveSessionTopic(userId, session) {
    let topic = null;
    if (session?.objectId && typeof db.getObjectById === 'function') {
      try {
        const object = await db.getObjectById(session.objectId);
        topic = normalizeTopic(object?.type) || detectTopic(object?.name);
      } catch (err) {
        console.error('assistant.object topic fetch failed', err);
      }
    }
    if (!topic) {
      const lastDiagnosis = getLastDiagnosis(userId);
      topic =
        normalizeTopic(lastDiagnosis?.crop) ||
        detectTopic(lastDiagnosis?.crop_ru) ||
        detectTopic(lastDiagnosis?.disease) ||
        detectTopic(lastDiagnosis?.disease_name_ru);
    }
    return topic;
  }

  function hasRecentAssistantReply(session) {
    const lastReplyAt = session?.lastAssistantReplyAt;
    if (!lastReplyAt) return false;
    return now() - lastReplyAt <= SHORT_REPLY_WINDOW_MS;
  }

  async function resolveUser(ctx) {
    const userId = ctx.from?.id;
    if (!userId || !db?.ensureUser) return null;
    try {
      if (typeof ensureUserWithBeta === 'function') {
        return await ensureUserWithBeta(db, userId);
      }
      return await db.ensureUser(userId);
    } catch (err) {
      console.error('assistant.ensureUser failed', err);
      return null;
    }
  }

  function isProUser(user) {
    if (!user?.pro_expires_at) return false;
    const dt = new Date(user.pro_expires_at);
    return !Number.isNaN(dt.getTime()) && dt.getTime() > Date.now();
  }

  async function ensureAccess(ctx, user) {
    if (!user) return false;
    if (isProUser(user) || isBetaUser(user)) return true;
    const shown = await sendAssistantPaywall(ctx, pool);
    return !shown;
  }

  async function start(ctx) {
    const userId = ctx.from?.id;
    if (!userId) return;
    const existing = await getSession(userId);
    if (existing?.lastStartAt && now() - existing.lastStartAt < START_THROTTLE_MS) {
      return;
    }
    const user = await resolveUser(ctx);
    if (!user?.api_key) {
      await ctx.reply(msg('assistant.error') || msg('diagnose_error'));
      return;
    }
    const allowed = await ensureAccess(ctx, user);
    if (!allowed) return;
    const recentRecord = await getLatestRecentRecord(user.id);
    const recentPayload = recentRecord?.diagnosis_payload || null;
    let objectId = recentRecord?.object_id ? Number(recentRecord.object_id) : null;
    if (!objectId && recentPayload?.object_id) {
      objectId = Number(recentPayload.object_id) || null;
    }
    if (!objectId && user?.last_object_id) {
      objectId = Number(user.last_object_id) || null;
    }
    const session = await saveSession(userId, {
      startedAt: now(),
      sessionId: generateSessionId(),
      pendingProposalId: null,
      objectId: objectId || null,
      recentDiagnosisId: recentRecord?.id || null,
      lastStartAt: now(),
      lastAssistantReplyAt: now(),
    });

    let object = null;
    if (session.objectId && typeof db.getObjectById === 'function') {
      try {
        object = await db.getObjectById(session.objectId);
        if (!object) {
          session.objectId = null;
          await saveSession(userId, { objectId: null });
        }
      } catch (err) {
        console.error('assistant.object fetch failed', err);
      }
    }

    let text = msg('assistant.start') || '🤖 Живой ассистент готов помочь. Задайте вопрос.';
    if (object?.name) {
      const name = sanitizeObjectName(object.name, msg('object.default_name'));
      text = msg('assistant.start_with_object', { name }) || text;
    }

    const keyboardRows = [];
    if (typeof db.listObjects === 'function') {
      try {
        const objects = await db.listObjects(user.id);
        if (objects?.length) {
          keyboardRows.push([
            { text: msg('assistant.choose_object_button') || '🪴 Выбрать растение', callback_data: 'assistant_choose_object' },
          ]);
        }
      } catch (err) {
        console.error('assistant.listObjects failed', err);
      }
    }
    const opts = keyboardRows.length ? { reply_markup: { inline_keyboard: keyboardRows } } : undefined;
    await ctx.reply(text, opts);
  }

  async function handleMessage(ctx) {
    const userId = ctx.from?.id;
    if (!userId) return false;
    const text = ctx.message?.text;
    if (!text || text.startsWith('/')) return false;
    const message = text.trim();
    if (!message) return false;
    const messageTopic = detectTopic(message);
    let session = await getSession(userId);
    if (isPunctuationOnly(message)) {
      await ctx.reply(msg('assistant.need_question') || 'Напишите вопрос текстом.');
      return true;
    }
    if (session && isShortAck(message) && !hasRecentAssistantReply(session)) {
      await deleteSession(userId);
      console.info('assistant.chat.short_ack_ignored', { userId });
      return true;
    }
    const shouldAutoStart = !session && looksLikeQuestion(message);
    if (!session && !shouldAutoStart) return false;
    const user = await resolveUser(ctx);
    if (!user?.api_key) {
      await ctx.reply(msg('assistant.error') || msg('diagnose_error'));
      return true;
    }
    const allowed = await ensureAccess(ctx, user);
    if (!allowed) return true;
    if (session?.objectId && messageTopic) {
      const sessionTopic = await resolveSessionTopic(userId, session);
      if (sessionTopic && sessionTopic !== messageTopic) {
        await saveSession(userId, {
          pendingMessage: message,
          pendingTopic: messageTopic,
        });
        const prompt =
          msg('assistant.context_mismatch', { topic: topicLabel(messageTopic) }) ||
          `Похоже, вопрос про ${topicLabel(messageTopic)}. Выберите растение или продолжим без привязки.`;
        await ctx.reply(prompt, {
          reply_markup: buildContextMismatchKeyboard(),
        });
        return true;
      }
    }
    if (!session) {
      const recentRecord = await getLatestRecentRecord(user.id);
      const recentPayload = recentRecord?.diagnosis_payload || null;
      let objectId = recentRecord?.object_id ? Number(recentRecord.object_id) : null;
      if (!objectId && recentPayload?.object_id) {
        objectId = Number(recentPayload.object_id) || null;
      }
      let recentDiagnosisId = recentRecord?.id || null;
      if (messageTopic) {
        const diagTopic = extractDiagnosisTopic(recentPayload);
        if (diagTopic && diagTopic !== messageTopic) {
          objectId = null;
          recentDiagnosisId = null;
        }
      }
      if (!objectId && user?.last_object_id) {
        objectId = Number(user.last_object_id) || null;
      }
      session = await saveSession(userId, {
        startedAt: now(),
        sessionId: generateSessionId(),
        pendingProposalId: null,
        objectId: objectId || null,
        recentDiagnosisId,
        lastStartAt: now(),
      });
    } else {
      await saveSession(userId);
    }
    await sendChatRequest(ctx, user, session, message);
    return true;
  }

  async function sendChatRequest(ctx, user, session, message) {
    const stopTyping = startTypingLoop(ctx);
    const userId = user.id;
    const metadata = {};
    const sessionHistory = normalizeHistory(session?.history);
    if (sessionHistory.length) {
      metadata.history = sessionHistory;
    }
    if (session?.recentDiagnosisId) {
      metadata.recent_diagnosis_id = session.recentDiagnosisId;
    }
    if (typeof db.getLatestPlanSessionForUser === 'function') {
      try {
        const planSession = await db.getLatestPlanSessionForUser(userId);
        if (planSession?.id) {
          metadata.plan_session_id = planSession.id;
        }
      } catch (err) {
        console.error('assistant.planSession fetch failed', err);
      }
    }
    const locale = ctx.from?.language_code || user.locale;
    if (locale) {
      metadata.locale = locale;
    }
    const payload = {
      session_id: session.sessionId,
      object_id: session.objectId || null,
      message,
      metadata: Object.keys(metadata).length ? metadata : null,
    };
    const headers = {
      ...buildApiHeaders({
        apiKey: user.api_key,
        userId,
        method: 'POST',
        path: '/v1/assistant/chat',
        body: payload,
      }),
      'Content-Type': 'application/json',
    };
    const logContext = {
      userId,
      sessionId: session.sessionId,
      objectId: session.objectId || null,
      messageLen: message.length,
      hasMetadata: Boolean(payload.metadata),
    };
    console.info('assistant.chat.request', logContext);
    let resp;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), CHAT_TIMEOUT_MS);
    try {
      resp = await fetch(`${API_BASE}/v1/assistant/chat`, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } catch (err) {
      if (err?.name === 'AbortError') {
        console.error('assistant.chat timeout', logContext);
        await ctx.reply(msg('error_GPT_TIMEOUT') || msg('diagnose_error') || 'GPT не ответил');
        return;
      }
      console.error('assistant.chat network error', err, logContext);
      await ctx.reply(msg('diagnose_error') || 'Ошибка диагностики');
      return;
    } finally {
      clearTimeout(timeout);
      stopTyping();
    }
    console.info('assistant.chat.response', { ...logContext, status: resp.status });
    if (!resp.ok) {
      await handleAssistantError(ctx, resp, 'assistant.chat failed', logContext);
      return;
    }
    let data = null;
    try {
      const raw = await resp.text();
      data = JSON.parse(raw);
    } catch (err) {
      console.error('assistant.chat parse error', err, logContext);
      await ctx.reply(msg('assistant.error'));
      return;
    }
    await sendAssistantReply(ctx, session, data, message);
  }

  async function sendAssistantReply(ctx, session, data, userMessage) {
    const answer = typeof data?.assistant_message === 'string' ? data.assistant_message.trim() : '';
    const followups = Array.isArray(data?.followups) ? data.followups.slice(0, MAX_FOLLOWUPS) : [];
    const proposals = Array.isArray(data?.proposals) ? data.proposals : [];
    const replyContext = {
      userId: ctx.from?.id || null,
      sessionId: session?.sessionId || null,
      answerLen: answer.length,
      followupsCount: followups.length,
      proposalsCount: proposals.length,
    };
    const lines = [];
    if (answer) {
      lines.push(answer);
    }
    if (followups.length) {
      const title = msg('assistant.followups_title') || 'Чтобы уточнить, ответьте:';
      lines.push([title, ...followups.map((line) => `• ${line}`)].join('\n'));
    }
    const text = lines.filter(Boolean).join('\n\n') || msg('assistant.error');
    const keyboard = buildAssistantKeyboard(proposals, session);
    const opts = keyboard ? { reply_markup: keyboard } : undefined;
    const preview = text ? text.replace(/\s+/g, ' ').slice(0, BODY_LOG_LIMIT) : '';
    console.info('assistant.chat.reply', { ...replyContext, preview });
    if (!text) {
      console.warn('assistant.chat.reply.empty', replyContext);
    }
    try {
      await ctx.reply(text, opts);
      if (ctx.from?.id) {
        const withUser = appendHistory(session?.history, 'user', userMessage);
        const withAssistant = appendHistory(withUser, 'assistant', answer || text);
        await saveSession(ctx.from.id, {
          lastAssistantReplyAt: now(),
          history: withAssistant,
        });
      }
    } catch (err) {
      console.error('assistant.chat.reply_failed', err, replyContext);
    }
  }

  function buildAssistantKeyboard(proposals, session) {
    if (!proposals?.length) return null;
    const rows = [];
    for (const proposal of proposals) {
      if (!proposal?.proposal_id) continue;
      const kind = proposal.kind || 'plan';
      let label = msg('assistant.pin_plan') || '📌 Зафиксировать план';
      if (kind === 'event') {
        label = msg('assistant.pin_event') || '📌 Зафиксировать напоминание';
      }
      if (kind === 'clarify') {
        continue;
      }
      const objectId = proposal.object_id || session?.objectId || '';
      rows.push([{ text: label, callback_data: `assistant_pin|${proposal.proposal_id}|${objectId || ''}` }]);
    }
    return rows.length ? { inline_keyboard: rows } : null;
  }

  async function chooseObject(ctx) {
    const tgUserId = ctx.from?.id;
    if (!tgUserId) return;
    const user = await resolveUser(ctx);
    if (!user) return;
    const session = await saveSession(tgUserId);
    if (typeof db.listObjects !== 'function') {
      await ctx.reply(msg('assistant.no_objects') || msg('photo_prompt'));
      return;
    }
    let objects = [];
    try {
      objects = await db.listObjects(user.id);
    } catch (err) {
      console.error('assistant.listObjects failed', err);
    }
    if (!objects?.length) {
      await ctx.reply(msg('assistant.no_objects') || msg('photo_prompt'));
      return;
    }
    const buttons = objects.map((obj) => [
      {
        text: sanitizeObjectName(obj?.name, msg('object.default_name')),
        callback_data: `assistant_object|${obj.id}`,
      },
    ]);
    const rows = buttons.slice(0, 8);
    if (session.pendingProposalId) {
      rows.push([
        {
          text: msg('assistant.continue_button') || '💬 Продолжить чат',
          callback_data: 'assistant_continue',
        },
      ]);
    }
    await ctx.reply(msg('assistant.choose_object') || 'Выберите растение:', {
      reply_markup: { inline_keyboard: rows },
    });
  }

  async function pickObject(ctx, objectId) {
    const tgUserId = ctx.from?.id;
    if (!tgUserId) return;
    const user = await resolveUser(ctx);
    if (!user) return;
    let session = await saveSession(tgUserId);
    const targetId = Number(objectId);
    if (!targetId) {
      await replyUserError(ctx, 'OBJECT_NOT_FOUND');
      return;
    }
    if (typeof db.getObjectById !== 'function') {
      await ctx.reply(msg('assistant.error'));
      return;
    }
    let object = null;
    try {
      object = await db.getObjectById(targetId);
    } catch (err) {
      console.error('assistant.getObjectById failed', err);
    }
    if (!object) {
      await replyUserError(ctx, 'OBJECT_NOT_FOUND');
      return;
    }
    if (Number(object.user_id) !== Number(user.id)) {
      await replyUserError(ctx, 'OBJECT_NOT_OWNED');
      return;
    }
    session = await saveSession(tgUserId, { objectId: targetId });
    if (typeof db.updateUserLastObject === 'function') {
      try {
        await db.updateUserLastObject(user.id, targetId);
      } catch (err) {
        console.error('assistant.updateUserLastObject failed', err);
      }
    }
    const name = sanitizeObjectName(object?.name, msg('object.default_name'));
    await ctx.reply(msg('assistant.object_selected', { name }) || `Выбрано растение: ${name}.`);
    if (session.pendingProposalId) {
      const proposalId = session.pendingProposalId;
      await saveSession(tgUserId, { pendingProposalId: null });
      await confirm(ctx, proposalId, targetId);
      return;
    }
    if (session.pendingMessage) {
      const pending = session.pendingMessage;
      await saveSession(tgUserId, {
        pendingMessage: null,
        pendingTopic: null,
      });
      session = (await getSession(tgUserId)) || session;
      await sendChatRequest(ctx, user, session, pending);
    }
  }

  async function confirm(ctx, proposalId, objectId) {
    const tgUserId = ctx.from?.id;
    if (!tgUserId) return;
    const user = await resolveUser(ctx);
    if (!user?.api_key) {
      await ctx.reply(msg('assistant.error') || msg('diagnose_error'));
      return;
    }
    const session = await saveSession(tgUserId);
    const userId = ctx.from?.id || user.id;
    if (typeof ctx.answerCbQuery === 'function') {
      try {
        await ctx.answerCbQuery(msg('assistant.confirm_toast') || 'Сохраняю...');
      } catch {
        // ignore toast errors
      }
    }
    const targetId = Number(objectId) || Number(session.objectId);
    if (!proposalId) {
      await ctx.reply(msg('assistant.confirm_failed'));
      return;
    }
    let dedupKey = null;
    if (userId && targetId) {
      dedupKey = getConfirmKey(userId, proposalId, targetId);
      if (isConfirmDuplicate(dedupKey)) {
        if (typeof ctx.answerCbQuery === 'function') {
          try {
            await ctx.answerCbQuery(msg('assistant.confirm_already') || 'Уже сохранил ✅');
          } catch {
            // ignore toast errors
          }
        }
        return;
      }
      confirmCache.set(dedupKey, { ts: now() });
    }
    if (!targetId) {
      await saveSession(tgUserId, { pendingProposalId: proposalId });
      await chooseObject(ctx);
      return;
    }
    const payload = {
      proposal_id: proposalId,
      object_id: targetId,
      plan_session_id: null,
    };
    const headers = {
      ...buildApiHeaders({
        apiKey: user.api_key,
        userId: user.id,
        method: 'POST',
        path: '/v1/assistant/confirm_plan',
        body: payload,
      }),
      'Content-Type': 'application/json',
    };
    const logContext = {
      userId: user.id,
      sessionId: session.sessionId,
      objectId: targetId || null,
      proposalId,
    };
    console.info('assistant.confirm.request', logContext);
    let resp;
    try {
      resp = await fetch(`${API_BASE}/v1/assistant/confirm_plan`, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
      });
    } catch (err) {
      console.error('assistant.confirm network error', err, logContext);
      if (dedupKey) {
        confirmCache.delete(dedupKey);
      }
      await ctx.reply(msg('assistant.confirm_failed') || msg('assistant.error'));
      return;
    }
    console.info('assistant.confirm.response', { ...logContext, status: resp.status });
    if (!resp.ok) {
      if (dedupKey) {
        confirmCache.delete(dedupKey);
      }
      await handleAssistantError(ctx, resp, 'assistant.confirm failed', logContext);
      return;
    }
    let data = null;
    try {
      const raw = await resp.text();
      data = JSON.parse(raw);
    } catch (err) {
      console.error('assistant.confirm parse error', err, logContext);
    }
    let objectName = null;
    if (typeof db.getObjectById === 'function') {
      try {
        const object = await db.getObjectById(targetId);
        if (object?.name) {
          objectName = sanitizeObjectName(object.name, msg('object.default_name'));
        }
      } catch (err) {
        console.error('assistant.confirm object fetch failed', err);
      }
    }
    const text = objectName
      ? msg('assistant.confirm_success', { name: objectName })
      : msg('assistant.confirm_success_fallback');
    const rows = [];
    if (data?.plan_id) {
      rows.push([{ text: msg('assistant.open_plan_button') || '📋 Открыть план', callback_data: `plan_plan_open|${data.plan_id}` }]);
    }
    rows.push([{ text: msg('assistant.continue_button') || '💬 Продолжить чат', callback_data: 'assistant_continue' }]);
    if (typeof ctx.editMessageReplyMarkup === 'function') {
      try {
        await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
      } catch (err) {
        console.debug('assistant.confirm.clear_buttons_failed', err?.message || err);
      }
    }
    await ctx.reply(text || msg('assistant.confirm_success_fallback'), {
      reply_markup: { inline_keyboard: rows },
    });
  }

  async function clearContext(ctx) {
    const userId = ctx.from?.id;
    if (!userId) return;
    if (typeof ctx.answerCbQuery === 'function') {
      try {
        await ctx.answerCbQuery();
      } catch {
        // ignore toast errors
      }
    }
    const session = await saveSession(userId, { objectId: null });
    const pending = session.pendingMessage;
    const nextSession = await saveSession(userId, {
      pendingMessage: null,
      pendingTopic: null,
    });
    if (!pending) {
      await ctx.reply(msg('assistant.context_cleared') || 'Ок, отвечаю без привязки к растению.');
      return;
    }
    const user = await resolveUser(ctx);
    if (!user?.api_key) {
      await ctx.reply(msg('assistant.error') || msg('diagnose_error'));
      return;
    }
    const allowed = await ensureAccess(ctx, user);
    if (!allowed) return;
    await sendChatRequest(ctx, user, nextSession, pending);
  }

  async function handleAssistantError(ctx, resp, logPrefix, context = null) {
    let detail = null;
    let raw = null;
    try {
      raw = await resp.text();
      detail = JSON.parse(raw);
    } catch (err) {
      detail = null;
    }
    const bodySnippet = raw ? raw.slice(0, BODY_LOG_LIMIT) : null;
    console.error(logPrefix, { status: resp.status, detail, bodySnippet, context });
    const code = detail?.detail?.message || detail?.message || null;
    if (code && USER_ERROR_CODES[code]) {
      await replyUserError(ctx, code);
      return;
    }
    await ctx.reply(msg('assistant.error'));
  }

  async function continueChat(ctx) {
    const userId = ctx.from?.id;
    if (!userId) return;
    await saveSession(userId);
    const text = msg('assistant.start') || '🤖 Живой ассистент готов помочь. Задайте вопрос.';
    await ctx.reply(text);
    await saveSession(userId, { lastAssistantReplyAt: now() });
  }

  return {
    start,
    handleMessage,
    chooseObject,
    pickObject,
    confirm,
    clearContext,
    continueChat,
    __getSessions,
  };
}

module.exports = { createAssistantChat };
