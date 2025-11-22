'use strict';

const { createNominatimProvider } = require('./nominatim');

const DEFAULT_CACHE_TTL_SECONDS = Number(process.env.GEOCODER_CACHE_TTL_S || '86400');
const USER_LIMIT_PER_MIN = Number(process.env.GEOCODER_USER_LIMIT_PER_MIN || '10');

function createRedisCache(redis, prefix = 'geo') {
  if (!redis) return null;
  const safePrefix = prefix.endsWith(':') ? prefix : `${prefix}:`;
  return {
    async get(key) {
      try {
        const raw = await redis.get(`${safePrefix}${key}`);
        if (!raw) return null;
        return JSON.parse(raw);
      } catch (err) {
        console.error('geocoder cache get failed', err);
        return null;
      }
    },
    async set(key, value, ttlSeconds) {
      try {
        const ttl = Number.isFinite(ttlSeconds) && ttlSeconds > 0 ? Math.floor(ttlSeconds) : DEFAULT_CACHE_TTL_SECONDS;
        await redis.set(`${safePrefix}${key}`, JSON.stringify(value), 'EX', Math.max(ttl, 60));
      } catch (err) {
        console.error('geocoder cache set failed', err);
      }
    },
  };
}

function createUserLimiter(redis, prefix = 'geo', limitPerMin = USER_LIMIT_PER_MIN) {
  if (!Number.isFinite(limitPerMin) || limitPerMin <= 0) return null;
  const safePrefix = prefix.endsWith(':') ? prefix : `${prefix}:`;
  if (redis) {
    return async (userKey) => {
      if (!userKey) return true;
      try {
        const key = `${safePrefix}rl:${userKey}`;
        const val = await redis.incr(key);
        if (val === 1) {
          await redis.expire(key, 60);
        }
        return val <= limitPerMin;
      } catch (err) {
        console.error('geocoder rate limit failed', err);
        return true;
      }
    };
  }
  const buckets = new Map();
  return async (userKey) => {
    if (!userKey) return true;
    const now = Date.now();
    const bucket = buckets.get(userKey) || { count: 0, resetAt: now + 60_000 };
    if (now > bucket.resetAt) {
      bucket.count = 0;
      bucket.resetAt = now + 60_000;
    }
    bucket.count += 1;
    buckets.set(userKey, bucket);
    return bucket.count <= limitPerMin;
  };
}

function normalizeQuery(value) {
  if (!value) return null;
  const text = String(value).trim();
  if (!text) return null;
  return text.replace(/\s+/g, ' ').toLowerCase();
}

function createGeocoder(options = {}) {
  const providerName = (options.provider || process.env.GEOCODER_PROVIDER || 'nominatim').toLowerCase();
  const provider =
    options.providerImpl ||
    (() => {
      switch (providerName) {
        case 'nominatim':
        default:
          return createNominatimProvider(options);
      }
    })();
  const cache = options.cache || createRedisCache(options.redis, options.cachePrefix);
  const ttlSeconds =
    Number.isFinite(options.ttlSeconds) && options.ttlSeconds > 0
      ? options.ttlSeconds
      : DEFAULT_CACHE_TTL_SECONDS;
  const userLimiter =
    options.userLimiter || createUserLimiter(options.redis, options.cachePrefix, options.userLimitPerMin);

  async function lookup(query, opts = {}) {
    const normalized = normalizeQuery(query);
    if (!normalized) return null;
    const userKey = opts.userId ? String(opts.userId) : null;
    if (userLimiter && userKey) {
      const allowed = await userLimiter(userKey);
      if (!allowed) {
        console.warn('geocoder user rate limit exceeded', { provider: providerName, user: userKey });
        return null;
      }
    }
    const cacheKey = `${providerName}:${normalized}`;
    if (cache) {
      const cached = await cache.get(cacheKey);
      if (cached) return cached;
    }
    const result = await provider.lookup(normalized, opts);
    if (result && cache) {
      await cache.set(cacheKey, result, ttlSeconds);
    }
    return result;
  }

  return { lookup };
}

module.exports = { createGeocoder };
