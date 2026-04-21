const { msg } = require('./utils');

const SUPPORT_SESSION_TTL_MS = Number(process.env.SUPPORT_SESSION_TTL_MS || 15 * 60 * 1000);
const SUPPORT_EXPIRED_GRACE_MS = Number(process.env.SUPPORT_SESSION_EXPIRED_GRACE_MS || '300000');
const REDIS_KEY_PREFIX = process.env.SUPPORT_SESSION_REDIS_PREFIX || 'bot:support_session:';
const pendingSupport = new Map();
let redisClient = null;
let redisKeyPrefix = REDIS_KEY_PREFIX;

function __getPendingSupport() {
  return pendingSupport;
}

function configurePersistence(options = {}) {
  redisClient = options.redis || null;
  redisKeyPrefix =
    typeof options.keyPrefix === 'string' && options.keyPrefix.trim()
      ? options.keyPrefix.trim()
      : REDIS_KEY_PREFIX;
}

function getSupportChatId() {
  const raw = (process.env.SUPPORT_CHAT_ID || '').trim();
  return raw || null;
}

function isExpired(entry) {
  if (!entry) return true;
  return Number(entry.expiresAt || 0) <= Date.now();
}

function getRedisKey(userId) {
  if (!userId) return null;
  return `${redisKeyPrefix}${userId}`;
}

function restoreSession(raw, userId = null) {
  if (!raw || typeof raw !== 'object') return null;
  const startedAt = Number(raw.startedAt || Date.now());
  const expiresAt = Number(raw.expiresAt || startedAt + SUPPORT_SESSION_TTL_MS);
  if (expiresAt <= Date.now()) return null;
  return {
    userId: raw.userId || userId || null,
    startedAt,
    expiresAt,
    promptMessageId: raw.promptMessageId ? Number(raw.promptMessageId) : null,
  };
}

async function persistSession(userId, session) {
  if (!redisClient || !userId) return;
  const key = getRedisKey(userId);
  if (!key) return;
  if (!session) {
    try {
      await redisClient.del(key);
    } catch (err) {
      console.error('support persist delete failed', err);
    }
    return;
  }
  const ttlMs = Math.max(1000, session.expiresAt - Date.now() + SUPPORT_EXPIRED_GRACE_MS);
  try {
    await redisClient.set(key, JSON.stringify(session), 'PX', ttlMs);
  } catch (err) {
    console.error('support persist set failed', err);
  }
}

async function hydrateSession(userId) {
  if (!userId) return { entry: null, expired: false };
  const existing = pendingSupport.get(userId);
  if (existing && !isExpired(existing)) return { entry: existing, expired: false };
  if (existing && isExpired(existing)) {
    pendingSupport.delete(userId);
    return { entry: null, expired: true };
  }
  if (!redisClient) return { entry: null, expired: false };
  const key = getRedisKey(userId);
  if (!key) return { entry: null, expired: false };
  try {
    const raw = await redisClient.get(key);
    if (!raw) return { entry: null, expired: false };
    const restored = restoreSession(JSON.parse(raw), userId);
    if (!restored) {
      await redisClient.del(key);
      return { entry: null, expired: true };
    }
    pendingSupport.set(userId, restored);
    return { entry: restored, expired: false };
  } catch (err) {
    console.error('support hydrate failed', err);
    return { entry: null, expired: false };
  }
}

async function clearSession(userId) {
  if (!userId) return;
  pendingSupport.delete(userId);
  await persistSession(userId, null);
}

async function getSessionState(userId) {
  const hydrated = await hydrateSession(userId);
  if (!hydrated?.entry) return { entry: null, expired: Boolean(hydrated?.expired) };
  const session = hydrated.entry;
  if (isExpired(session)) {
    await clearSession(userId);
    return { entry: null, expired: true };
  }
  return { entry: session, expired: false };
}

function isSupportPromptReply(ctx) {
  const reply = ctx?.message?.reply_to_message;
  if (!reply?.from?.is_bot) return false;
  const replyText = String(reply.text || reply.caption || '').trim();
  return replyText === String(msg('support_prompt')).trim();
}

function buildSupportPayload(ctx, text) {
  const from = ctx.from || {};
  const name = [from.first_name, from.last_name].filter(Boolean).join(' ') || '—';
  const username = from.username ? `@${from.username}` : '—';
  const chatId = ctx.chat?.id != null ? String(ctx.chat.id) : '—';
  const locale = from.language_code || '—';
  const timestamp = new Date().toISOString();
  const header = msg('support_forward_header', {
    name,
    username,
    user_id: from.id || '—',
    chat_id: chatId,
    locale,
    timestamp,
  });
  const body = msg('support_forward_body', { text });
  return [header, body].filter(Boolean).join('\n\n');
}

async function start(ctx) {
  const supportChatId = getSupportChatId();
  if (!supportChatId) {
    await ctx.reply(msg('support_unavailable'));
    return false;
  }
  const userId = ctx.from?.id;
  if (!userId) return false;
  const startedAt = Date.now();
  const prompt = await ctx.reply(msg('support_prompt'), {
    reply_markup: {
      inline_keyboard: [[{ text: msg('support_cancel_button'), callback_data: 'support_cancel' }]],
    },
  });
  const session = {
    userId,
    startedAt,
    expiresAt: startedAt + SUPPORT_SESSION_TTL_MS,
    promptMessageId: prompt?.message_id ? Number(prompt.message_id) : null,
  };
  pendingSupport.set(userId, session);
  await persistSession(userId, session);
  return true;
}

async function cancel(ctx) {
  const userId = ctx.from?.id;
  await clearSession(userId);
  await ctx.reply(msg('support_cancelled'));
}

async function handleSupportText(ctx) {
  const userId = ctx.from?.id;
  const text = ctx.message?.text?.trim();
  if (!userId || !text) return false;
  const { entry: pending, expired } = await getSessionState(userId);
  if (!pending) {
    if (expired || isSupportPromptReply(ctx)) {
      await ctx.reply(msg('support_expired'));
      return true;
    }
    return false;
  }
  if (text.startsWith('/')) return false;
  const supportChatId = getSupportChatId();
  if (!supportChatId) {
    await clearSession(userId);
    await ctx.reply(msg('support_unavailable'));
    return true;
  }
  try {
    await ctx.telegram.sendMessage(supportChatId, buildSupportPayload(ctx, text));
  } catch (err) {
    console.error('support.send_failed', err);
    await ctx.reply(msg('support_send_failed'));
    return true;
  }
  await clearSession(userId);
  await ctx.reply(msg('support_sent'));
  return true;
}

module.exports = {
  configurePersistence,
  start,
  cancel,
  handleSupportText,
  __getPendingSupport,
};
