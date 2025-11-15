'use strict';

async function logFunnelEvent(db, payload = {}) {
  if (!db || typeof db.logFunnelEvent !== 'function') return;
  if (!payload.event || !payload.userId) return;
  try {
    await db.logFunnelEvent({
      event: payload.event,
      userId: payload.userId,
      objectId: payload.objectId || null,
      planId: payload.planId || null,
      data: payload.data || null,
    });
  } catch (err) {
    console.error('funnel log failed', err);
  }
}

module.exports = { logFunnelEvent };

