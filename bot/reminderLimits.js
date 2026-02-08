'use strict';

const DEFAULT_FREE_REMINDER_LIMIT = 1;

async function limitRemindersForUser(db, userId, reminders, limit = DEFAULT_FREE_REMINDER_LIMIT) {
  if (!db || !userId || !Array.isArray(reminders) || reminders.length === 0) {
    return { allowed: reminders || [], limited: false, remaining: limit };
  }
  if (typeof db.getCaseUsage !== 'function') {
    return { allowed: reminders, limited: false, remaining: limit };
  }
  const usage = await db.getCaseUsage(userId);
  if (usage?.isPro || usage?.isBeta) {
    return { allowed: reminders, limited: false, remaining: Infinity };
  }
  if (typeof db.countActiveReminders !== 'function') {
    return { allowed: reminders, limited: false, remaining: limit };
  }
  const activeCount = await db.countActiveReminders(userId);
  const remaining = Math.max(0, limit - activeCount);
  if (remaining <= 0) {
    return { allowed: [], limited: true, remaining: 0, activeCount };
  }
  const sorted = [...reminders].sort(
    (a, b) => new Date(a.fire_at).getTime() - new Date(b.fire_at).getTime(),
  );
  return {
    allowed: sorted.slice(0, remaining),
    limited: reminders.length > remaining,
    remaining,
    activeCount,
  };
}

module.exports = { limitRemindersForUser };
