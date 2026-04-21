'use strict';

const DEFAULT_TTL_MS = 15 * 60 * 1000;
const parsedTtl = Number(process.env.FAQ_REGION_PROMPT_TTL_MS || DEFAULT_TTL_MS);
const PROMPT_TTL_MS = Number.isFinite(parsedTtl) && parsedTtl > 0 ? parsedTtl : DEFAULT_TTL_MS;
const EXPIRED_GRACE_MS = Number(process.env.FAQ_REGION_PROMPT_EXPIRED_GRACE_MS || '300000');
const REDIS_KEY_PREFIX = process.env.REGION_PROMPT_REDIS_PREFIX || 'bot:region_prompt:';

const prompts = new Map();
let redisClient = null;
let redisKeyPrefix = REDIS_KEY_PREFIX;

function __getPrompts() {
  return prompts;
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

function now() {
  return Date.now();
}

function restorePrompt(raw, userId = null) {
  if (!raw || typeof raw !== 'object') return null;
  const createdAt = Number(raw.createdAt || now());
  if (!Number.isFinite(createdAt)) return null;
  if (now() - createdAt > PROMPT_TTL_MS) return null;
  return { userId: raw.userId || userId || null, createdAt };
}

async function persistPrompt(userId, entry) {
  if (!redisClient || !userId) return;
  const key = getRedisKey(userId);
  if (!key) return;
  if (!entry) {
    try {
      await redisClient.del(key);
    } catch (err) {
      console.error('regionPrompt persist delete failed', err);
    }
    return;
  }
  const ttlMs = Math.max(1000, entry.createdAt + PROMPT_TTL_MS - now() + EXPIRED_GRACE_MS);
  try {
    await redisClient.set(key, JSON.stringify(entry), 'PX', ttlMs);
  } catch (err) {
    console.error('regionPrompt persist set failed', err);
  }
}

async function hydratePrompt(userId) {
  if (!userId) return null;
  cleanup();
  const existing = prompts.get(userId);
  if (existing) return existing;
  if (!redisClient) return null;
  const key = getRedisKey(userId);
  if (!key) return null;
  try {
    const raw = await redisClient.get(key);
    if (!raw) return null;
    const restored = restorePrompt(JSON.parse(raw), userId);
    if (!restored) {
      await redisClient.del(key);
      return null;
    }
    prompts.set(userId, restored);
    return restored;
  } catch (err) {
    console.error('regionPrompt hydrate failed', err);
    return null;
  }
}

function cleanup() {
  const ts = now();
  for (const [userId, entry] of prompts.entries()) {
    if (!entry?.createdAt || ts - entry.createdAt > PROMPT_TTL_MS) {
      prompts.delete(userId);
    }
  }
}

function markAwaitingRegion(userId) {
  if (!userId) return false;
  cleanup();
  prompts.set(userId, { userId, createdAt: now() });
  return true;
}

async function markAwaitingRegionAsync(userId) {
  if (!markAwaitingRegion(userId)) return false;
  await persistPrompt(userId, prompts.get(userId));
  return true;
}

function isAwaitingRegion(userId) {
  if (!userId) return false;
  cleanup();
  return prompts.has(userId);
}

async function isAwaitingRegionAsync(userId) {
  if (!userId) return false;
  cleanup();
  if (prompts.has(userId)) return true;
  return Boolean(await hydratePrompt(userId));
}

function clearAwaitingRegion(userId) {
  if (!userId) return false;
  return prompts.delete(userId);
}

async function clearAwaitingRegionAsync(userId) {
  clearAwaitingRegion(userId);
  await persistPrompt(userId, null);
}

module.exports = {
  configurePersistence,
  markAwaitingRegion,
  markAwaitingRegionAsync,
  isAwaitingRegion,
  isAwaitingRegionAsync,
  clearAwaitingRegion,
  clearAwaitingRegionAsync,
  __getPrompts,
};
