'use strict';

const DEFAULT_BASE_URL = process.env.GEOCODER_BASE_URL || 'https://nominatim.openstreetmap.org/search';
const DEFAULT_TIMEOUT_MS = Number(process.env.GEOCODER_TIMEOUT_MS || '5000');
const DEFAULT_USER_AGENT = process.env.GEOCODER_USER_AGENT || 'agronom-bot/1.0';
const DEFAULT_RETRIES = Number(process.env.GEOCODER_RETRIES || '2');
const DEFAULT_RATE_LIMIT_MS = Number(process.env.GEOCODER_RATE_LIMIT_MS || '0');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createNominatimProvider(options = {}) {
  const fetchImpl = options.fetchImpl || global.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new Error('Nominatim provider requires fetch implementation');
  }
  const baseUrl = options.baseUrl || DEFAULT_BASE_URL;
  const userAgent = options.userAgent || DEFAULT_USER_AGENT;
  const timeoutMs =
    Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
      ? options.timeoutMs
      : DEFAULT_TIMEOUT_MS;
  const retries =
    Number.isFinite(options.retries) && options.retries >= 0 ? options.retries : DEFAULT_RETRIES;
  const rateLimitMs =
    Number.isFinite(options.rateLimitMs) && options.rateLimitMs >= 0
      ? options.rateLimitMs
      : DEFAULT_RATE_LIMIT_MS;
  let lastRequestTs = 0;

  async function rateLimit() {
    if (!rateLimitMs) return;
    const now = Date.now();
    const wait = lastRequestTs + rateLimitMs - now;
    if (wait > 0) {
      await sleep(wait);
    }
    lastRequestTs = Date.now();
  }

  async function lookup(query, opts = {}) {
    if (!query) return null;
    const url = new URL(baseUrl);
    url.searchParams.set('format', 'json');
    url.searchParams.set('addressdetails', '1');
    url.searchParams.set('limit', String(opts.limit || 1));
    url.searchParams.set('q', query);

    let attempt = 0;
    while (attempt <= retries) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      if (typeof timer.unref === 'function') {
        timer.unref();
      }
      try {
        await rateLimit();
        const resp = await fetchImpl(url, {
          headers: {
            'User-Agent': userAgent,
            'Accept-Language': opts.language || 'ru',
          },
          signal: controller.signal,
        });
        if (!resp.ok) {
          throw new Error(`geocoder_http_${resp.status}`);
        }
        const payload = await resp.json();
        const first = Array.isArray(payload) ? payload[0] : null;
        if (!first) return null;
        const lat = Number(first.lat);
        const lon = Number(first.lon);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
        return {
          lat,
          lon,
          label: first.display_name || query,
          confidence: typeof first.importance === 'number' ? first.importance : Number(first.importance) || null,
        };
      } catch (err) {
        if (err.name === 'AbortError') {
          console.warn('geocoder timeout', { provider: 'nominatim', query, attempt });
        } else {
          console.error('geocoder request failed', err, { attempt });
        }
        attempt += 1;
        if (attempt > retries) {
          return null;
        }
        const backoff = Math.min(1000 * attempt, 2000);
        await sleep(backoff);
      } finally {
        clearTimeout(timer);
      }
    }
  }

  return { lookup };
}

module.exports = { createNominatimProvider };
