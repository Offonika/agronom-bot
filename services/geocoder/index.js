'use strict';

const { createNominatimProvider } = require('./nominatim');

const DEFAULT_CACHE_TTL_SECONDS = Number(process.env.GEOCODER_CACHE_TTL_S || '86400');

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

  async function lookup(query, opts = {}) {
    const normalized = normalizeQuery(query);
    if (!normalized) return null;
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
