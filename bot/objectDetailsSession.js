'use strict';

const DETAILS_PROMPT_TTL_MS = Number(process.env.OBJECT_DETAILS_PROMPT_TTL_MS || `${24 * 60 * 60 * 1000}`);
const DETAILS_EXPIRED_GRACE_MS = Number(process.env.OBJECT_DETAILS_EXPIRED_GRACE_MS || '300000');
const REDIS_KEY_PREFIX = process.env.OBJECT_DETAILS_SESSION_REDIS_PREFIX || 'bot:object_details_session:';

const sessions = new Map();
let redisClient = null;
let redisKeyPrefix = REDIS_KEY_PREFIX;

function __getSessions() {
  return sessions;
}

function now() {
  return Date.now();
}

function configurePersistence(options = {}) {
  redisClient = options.redis || null;
  redisKeyPrefix =
    typeof options.keyPrefix === 'string' && options.keyPrefix.trim()
      ? options.keyPrefix.trim()
      : REDIS_KEY_PREFIX;
}

function getRedisKey(userId) {
  if (!userId) return null;
  return `${redisKeyPrefix}${userId}`;
}

function normalizeField(field) {
  return ['variety', 'note', 'rename'].includes(field) ? field : null;
}

function restoreSession(raw, userId = null) {
  if (!raw || typeof raw !== 'object') return null;
  const objectId = Number(raw.objectId);
  const promptMessageId = Number(raw.promptMessageId);
  const field = normalizeField(raw.field);
  if (!Number.isFinite(objectId) || objectId <= 0 || !field) return null;
  if (!Number.isFinite(promptMessageId) || promptMessageId <= 0) return null;
  const createdAt = Number(raw.createdAt || now());
  const expiresAt = Number(raw.expiresAt || createdAt + DETAILS_PROMPT_TTL_MS);
  if (expiresAt <= now()) return null;
  return {
    userId: raw.userId || userId || null,
    objectId,
    field,
    promptMessageId,
    createdAt,
    expiresAt,
  };
}

function isExpired(session) {
  if (!session) return true;
  return Number(session.expiresAt || 0) <= now();
}

async function persistSession(userId, session) {
  if (!redisClient || !userId) return;
  const key = getRedisKey(userId);
  if (!key) return;
  if (!session) {
    try {
      await redisClient.del(key);
    } catch (err) {
      console.error('objectDetails persist delete failed', err);
    }
    return;
  }
  const ttlMs = Math.max(1000, session.expiresAt - now() + DETAILS_EXPIRED_GRACE_MS);
  try {
    await redisClient.set(key, JSON.stringify(session), 'PX', ttlMs);
  } catch (err) {
    console.error('objectDetails persist set failed', err);
  }
}

async function hydrateSession(userId) {
  if (!userId) return { entry: null, expired: false };
  const existing = sessions.get(userId);
  if (existing && !isExpired(existing)) return { entry: existing, expired: false };
  if (existing && isExpired(existing)) {
    sessions.delete(userId);
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
    sessions.set(userId, restored);
    return { entry: restored, expired: false };
  } catch (err) {
    console.error('objectDetails hydrate failed', err);
    return { entry: null, expired: false };
  }
}

async function setSessionAsync(userId, session) {
  if (!userId || !session) return null;
  const restored = restoreSession(
    {
      ...session,
      userId,
      createdAt: session.createdAt || now(),
      expiresAt: session.expiresAt || (session.createdAt || now()) + DETAILS_PROMPT_TTL_MS,
    },
    userId,
  );
  if (!restored) return null;
  sessions.set(userId, restored);
  await persistSession(userId, restored);
  return restored;
}

async function clearSessionAsync(userId) {
  if (!userId) return;
  sessions.delete(userId);
  await persistSession(userId, null);
}

async function peekSessionAsync(userId) {
  const hydrated = await hydrateSession(userId);
  if (!hydrated?.entry) return { entry: null, expired: Boolean(hydrated?.expired) };
  const session = hydrated.entry;
  if (isExpired(session)) {
    await clearSessionAsync(userId);
    return { entry: null, expired: true };
  }
  return { entry: session, expired: false };
}

module.exports = {
  DETAILS_PROMPT_TTL_MS,
  configurePersistence,
  setSessionAsync,
  peekSessionAsync,
  clearSessionAsync,
  __getSessions,
};
