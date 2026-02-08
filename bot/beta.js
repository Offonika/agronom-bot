'use strict';

function parseTesterIds(raw) {
  if (!raw) return new Set();
  const text = String(raw).trim();
  if (!text) return new Set();
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) {
      return new Set(parsed.map((v) => Number(v)).filter((v) => Number.isFinite(v)));
    }
  } catch {
    // fallback to comma-separated list
  }
  return new Set(
    text
      .split(',')
      .map((item) => Number(item.trim()))
      .filter((v) => Number.isFinite(v)),
  );
}

function isBetaEnabled() {
  return process.env.BETA_HOUSEPLANTS_ENABLED === 'true';
}

function isOpenBeta() {
  return process.env.BETA_OPEN_ALL === 'true';
}

function isTesterId(tgId) {
  if (!tgId) return false;
  const testerIds = parseTesterIds(process.env.BETA_TESTER_IDS);
  if (!testerIds.size) return false;
  return testerIds.has(Number(tgId));
}

function isBetaUser(user) {
  return Boolean(isBetaEnabled() && (isOpenBeta() || user?.is_beta));
}

function betaFollowupDays() {
  const value = Number(process.env.BETA_FOLLOWUP_DAYS || '3');
  return Number.isFinite(value) && value > 0 ? value : 3;
}

function betaRetryDays() {
  const value = Number(process.env.BETA_FOLLOWUP_RETRY_DAYS || '2');
  return Number.isFinite(value) && value > 0 ? value : 2;
}

async function ensureUserWithBeta(db, tgId) {
  if (!db?.ensureUser || !tgId) return null;
  const user = await db.ensureUser(tgId);
  if (!isBetaEnabled() || (!isOpenBeta() && !isTesterId(tgId))) {
    return user;
  }
  if (user?.is_beta) {
    return user;
  }
  if (typeof db.updateUserBeta === 'function') {
    const updated = await db.updateUserBeta(user.id, { isBeta: true });
    if (db.logBetaEvent && !db.getBetaEvent) {
      try {
        await db.logBetaEvent({ userId: user.id, eventType: 'beta_entered' });
      } catch (err) {
        console.error('beta_entered log failed', err);
      }
    } else if (db.logBetaEvent && db.getBetaEvent) {
      try {
        const existing = await db.getBetaEvent(user.id, 'beta_entered');
        if (!existing) {
          await db.logBetaEvent({ userId: user.id, eventType: 'beta_entered' });
        }
      } catch (err) {
        console.error('beta_entered log failed', err);
      }
    }
    return updated || user;
  }
  return user;
}

async function logBetaEventOnce(db, userId, eventType, payload = {}) {
  if (!db?.logBetaEvent || !db.getBetaEvent || !userId || !eventType) return null;
  try {
    const existing = await db.getBetaEvent(userId, eventType);
    if (existing) return existing;
    return db.logBetaEvent({ userId, eventType, payload });
  } catch (err) {
    console.error('beta event log failed', err);
    return null;
  }
}

module.exports = {
  isBetaEnabled,
  isTesterId,
  isBetaUser,
  betaFollowupDays,
  betaRetryDays,
  ensureUserWithBeta,
  logBetaEventOnce,
};
