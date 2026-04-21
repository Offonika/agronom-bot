'use strict';

const LOCATION_REQUEST_TTL_MS = Number(process.env.LOCATION_REQUEST_TTL_MS || '120000');
const LOCATION_MAX_RETRIES = Number(process.env.LOCATION_MAX_RETRIES || '3');
const LOCATION_COOLDOWN_MS = Number(process.env.LOCATION_COOLDOWN_MS || `${5 * 60 * 1000}`); // 5 min
const LOCATION_EXPIRED_GRACE_MS = Number(process.env.LOCATION_REQUEST_EXPIRED_GRACE_MS || '300000');
const REDIS_KEY_PREFIX = process.env.LOCATION_SESSION_REDIS_PREFIX || 'bot:location_session:';

const store = new Map();
let redisClient = null;
let redisKeyPrefix = REDIS_KEY_PREFIX;

function __getStore() {
  return store;
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

function restoreEntry(raw, userId = null) {
  if (!raw || typeof raw !== 'object') return null;
  const objectId = Number(raw.objectId);
  if (!Number.isFinite(objectId) || objectId <= 0) return null;
  const retries = Number(raw.retries || 1);
  const expiresAt = Number(raw.expiresAt || 0);
  const cooldownUntil = Number(raw.cooldownUntil || 0);
  const entry = {
    userId: raw.userId || userId || null,
    objectId,
    mode: raw.mode === 'address' ? 'address' : 'geo',
    retries: Number.isFinite(retries) && retries > 0 ? retries : 1,
    expiresAt: Number.isFinite(expiresAt) ? expiresAt : now() + LOCATION_REQUEST_TTL_MS,
    cooldownUntil: Number.isFinite(cooldownUntil) ? cooldownUntil : now() + LOCATION_COOLDOWN_MS,
  };
  if (entry.expiresAt <= now()) return null;
  return entry;
}

async function persistEntry(userId, entry) {
  if (!redisClient || !userId) return;
  const key = getRedisKey(userId);
  if (!key) return;
  if (!entry) {
    try {
      await redisClient.del(key);
    } catch (err) {
      console.error('locationSession persist delete failed', err);
    }
    return;
  }
  const ttlMs = Math.max(1000, entry.expiresAt - now() + LOCATION_EXPIRED_GRACE_MS);
  try {
    await redisClient.set(key, JSON.stringify(entry), 'PX', ttlMs);
  } catch (err) {
    console.error('locationSession persist set failed', err);
  }
}

async function hydrateEntry(userId) {
  const inMemory = fetchEntry(userId, false);
  if (inMemory.entry || inMemory.expired || !redisClient || !userId) return inMemory;
  const key = getRedisKey(userId);
  if (!key) return { entry: null, expired: false };
  try {
    const raw = await redisClient.get(key);
    if (!raw) return { entry: null, expired: false };
    const restored = restoreEntry(JSON.parse(raw), userId);
    if (!restored) {
      await redisClient.del(key);
      return { entry: null, expired: true };
    }
    store.set(userId, restored);
    return { entry: restored, expired: false };
  } catch (err) {
    console.error('locationSession hydrate failed', err);
    return { entry: null, expired: false };
  }
}

function rememberLocationRequest(userId, objectId, mode = 'geo') {
  if (!userId || !objectId) return false;
  const existing = store.get(userId);
  const retries = existing?.retries ? existing.retries + 1 : 1;
  if (retries > LOCATION_MAX_RETRIES) {
    store.delete(userId);
    return false;
  }
  store.set(userId, {
    objectId,
    mode,
    expiresAt: now() + Math.max(LOCATION_REQUEST_TTL_MS, 1000),
    retries,
    cooldownUntil: now() + LOCATION_COOLDOWN_MS,
  });
  return true;
}

async function rememberLocationRequestAsync(userId, objectId, mode = 'geo') {
  if (!userId || !objectId) return false;
  await hydrateEntry(userId);
  const ok = rememberLocationRequest(userId, objectId, mode);
  if (!ok) {
    await persistEntry(userId, null);
    return false;
  }
  await persistEntry(userId, store.get(userId));
  return true;
}

function clearLocationRequest(userId) {
  if (!userId) return;
  store.delete(userId);
}

async function clearLocationRequestAsync(userId) {
  clearLocationRequest(userId);
  await persistEntry(userId, null);
}

function fetchEntry(userId, remove = false) {
  if (!userId) return { entry: null, expired: false };
  const record = store.get(userId);
  if (!record) return { entry: null, expired: false };
  if (record.expiresAt && record.expiresAt < now()) {
    store.delete(userId);
    return { entry: null, expired: true };
  }
  if (remove) {
    store.delete(userId);
  }
  return { entry: record, expired: false };
}

function consumeLocationRequest(userId) {
  return fetchEntry(userId, true);
}

function peekLocationRequest(userId) {
  return fetchEntry(userId, false);
}

async function fetchEntryAsync(userId, remove = false) {
  const hydrated = await hydrateEntry(userId);
  if (!hydrated.entry && hydrated.expired) {
    await persistEntry(userId, null);
    return hydrated;
  }
  const result = fetchEntry(userId, remove);
  if (!result.entry && result.expired) {
    await persistEntry(userId, null);
  } else if (remove && result.entry) {
    await persistEntry(userId, null);
  }
  return result;
}

async function consumeLocationRequestAsync(userId) {
  return fetchEntryAsync(userId, true);
}

async function peekLocationRequestAsync(userId) {
  return fetchEntryAsync(userId, false);
}

module.exports = {
  configurePersistence,
  rememberLocationRequest,
  rememberLocationRequestAsync,
  consumeLocationRequest,
  consumeLocationRequestAsync,
  peekLocationRequest,
  peekLocationRequestAsync,
  clearLocationRequest,
  clearLocationRequestAsync,
  __getStore,
};
