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
const MAX_FOLLOWUPS = 3;
const BODY_LOG_LIMIT = 500;
const CONFIRM_DEDUP_MS = Number(process.env.ASSISTANT_CONFIRM_DEDUP_MS || '120000');
const SHORT_REPLY_WINDOW_MS = Number(process.env.ASSISTANT_SHORT_REPLY_WINDOW_MS || '120000');
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

function createAssistantChat({ db, pool } = {}) {
  if (!db) {
    throw new Error('assistantChat requires db');
  }
  const sessions = new Map();
  const confirmCache = new Map();

  function now() {
    return Date.now();
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

  function getSession(userId) {
    const session = sessions.get(userId);
    if (!session) return null;
    if (isExpired(session)) {
      sessions.delete(userId);
      return null;
    }
    return session;
  }

  function saveSession(userId, patch = {}) {
    const current = sessions.get(userId) || {
      sessionId: generateSessionId(),
      startedAt: now(),
      lastActiveAt: now(),
      objectId: null,
      pendingProposalId: null,
      pendingMessage: null,
      pendingTopic: null,
    };
    const next = { ...current, ...patch };
    next.lastActiveAt = now();
    sessions.set(userId, next);
    return next;
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
    const existing = getSession(userId);
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
    const session = saveSession(userId, {
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
          saveSession(userId, { objectId: null });
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
    let session = getSession(userId);
    if (isPunctuationOnly(message)) {
      await ctx.reply(msg('assistant.need_question') || 'Напишите вопрос текстом.');
      return true;
    }
    if (session && isShortAck(message) && !hasRecentAssistantReply(session)) {
      sessions.delete(userId);
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
        session.pendingMessage = message;
        session.pendingTopic = messageTopic;
        sessions.set(userId, session);
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
      session = saveSession(userId, {
        startedAt: now(),
        sessionId: generateSessionId(),
        pendingProposalId: null,
        objectId: objectId || null,
        recentDiagnosisId,
        lastStartAt: now(),
      });
    } else {
      saveSession(userId);
    }
    await sendChatRequest(ctx, user, session, message);
    return true;
  }

  async function sendChatRequest(ctx, user, session, message) {
    const userId = user.id;
    const metadata = {};
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
    try {
      resp = await fetch(`${API_BASE}/v1/assistant/chat`, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
      });
    } catch (err) {
      console.error('assistant.chat network error', err, logContext);
      await ctx.reply(msg('assistant.error'));
      return;
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
    await sendAssistantReply(ctx, session, data);
  }

  async function sendAssistantReply(ctx, session, data) {
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
      const title = msg('assistant.followups_title') || 'Можно спросить:';
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
        saveSession(ctx.from.id, { lastAssistantReplyAt: now() });
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
    const user = await resolveUser(ctx);
    if (!user) return;
    const session = saveSession(user.id);
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
    const user = await resolveUser(ctx);
    if (!user) return;
    const session = saveSession(user.id);
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
    session.objectId = targetId;
    sessions.set(user.id, session);
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
      session.pendingProposalId = null;
      sessions.set(user.id, session);
      await confirm(ctx, proposalId, targetId);
      return;
    }
    if (session.pendingMessage) {
      const pending = session.pendingMessage;
      session.pendingMessage = null;
      session.pendingTopic = null;
      sessions.set(user.id, session);
      await sendChatRequest(ctx, user, session, pending);
    }
  }

  async function confirm(ctx, proposalId, objectId) {
    const user = await resolveUser(ctx);
    if (!user?.api_key) {
      await ctx.reply(msg('assistant.error') || msg('diagnose_error'));
      return;
    }
    const session = saveSession(user.id);
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
      session.pendingProposalId = proposalId;
      sessions.set(user.id, session);
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
    const session = saveSession(userId, { objectId: null });
    const pending = session.pendingMessage;
    session.pendingMessage = null;
    session.pendingTopic = null;
    sessions.set(userId, session);
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
    await sendChatRequest(ctx, user, session, pending);
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
    const session = saveSession(userId);
    const text = msg('assistant.start') || '🤖 Живой ассистент готов помочь. Задайте вопрос.';
    await ctx.reply(text);
    session.lastAssistantReplyAt = now();
    sessions.set(userId, session);
  }

  return {
    start,
    handleMessage,
    chooseObject,
    pickObject,
    confirm,
    clearContext,
    continueChat,
  };
}

module.exports = { createAssistantChat };
