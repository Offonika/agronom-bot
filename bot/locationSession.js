'use strict';

const LOCATION_REQUEST_TTL_MS = Number(process.env.LOCATION_REQUEST_TTL_MS || '120000');
const LOCATION_MAX_RETRIES = Number(process.env.LOCATION_MAX_RETRIES || '3');
const LOCATION_COOLDOWN_MS = Number(process.env.LOCATION_COOLDOWN_MS || `${5 * 60 * 1000}`); // 5 min

const store = new Map();

function now() {
  return Date.now();
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

function clearLocationRequest(userId) {
  if (!userId) return;
  store.delete(userId);
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

module.exports = {
  rememberLocationRequest,
  consumeLocationRequest,
  peekLocationRequest,
  clearLocationRequest,
};
