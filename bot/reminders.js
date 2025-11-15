'use strict';

const { msg } = require('./utils');

function formatReminder(reminder) {
  const stage = reminder.stage_title || msg('reminder_stage_fallback');
  if (reminder.event_type === 'phi') {
    return msg('reminder_phi', { plan: reminder.plan_title || '', stage });
  }
  return msg('reminder_treatment', { plan: reminder.plan_title || '', stage });
}

function createReminderScheduler({ bot, db, intervalMs }) {
  if (!bot || !db) throw new Error('reminders scheduler requires bot and db');
  const tickInterval = Number(intervalMs || process.env.REMINDER_TICK_MS || 3600000);
  let sweepTimer = null;
  let running = false;
  const timers = new Map();

  async function deliver(reminder) {
    try {
      const text = formatReminder(reminder);
      await bot.telegram.sendMessage(reminder.user_tg_id, text);
      await db.markReminderSent(reminder.id);
    } catch (err) {
      console.error('reminder send error', err);
    }
  }

  function scheduleReminder(reminder) {
    if (!reminder || !reminder.id || reminder.sent_at) return;
    if (timers.has(reminder.id)) return;
    const fireAt = new Date(reminder.fire_at).getTime();
    const delay = Math.max(fireAt - Date.now(), 0);
    const timeout = setTimeout(async () => {
      timers.delete(reminder.id);
      await deliver(reminder);
    }, delay);
    if (typeof timeout.unref === 'function') timeout.unref();
    timers.set(reminder.id, timeout);
  }

  async function hydrate() {
    try {
      const pending = await db.pendingReminders(new Date());
      pending.forEach(scheduleReminder);
    } catch (err) {
      console.error('reminder hydrate error', err);
    }
  }

  async function tick() {
    try {
      const due = await db.dueReminders(new Date());
      for (const reminder of due) {
        const existing = timers.get(reminder.id);
        if (existing) {
          clearTimeout(existing);
          timers.delete(reminder.id);
        }
        await deliver(reminder);
      }
    } catch (err) {
      console.error('reminder tick error', err);
    }
  }

  async function start() {
    if (running) return;
    running = true;
    await hydrate();
    await tick();
    sweepTimer = setInterval(async () => {
      await tick();
      await hydrate();
    }, tickInterval);
    if (typeof sweepTimer.unref === 'function') sweepTimer.unref();
  }

  function stop() {
    if (sweepTimer) clearInterval(sweepTimer);
    sweepTimer = null;
    running = false;
    for (const timeout of timers.values()) {
      clearTimeout(timeout);
    }
    timers.clear();
  }

  function scheduleMany(reminders = []) {
    reminders.forEach(scheduleReminder);
  }

  return { start, stop, tick, scheduleMany };
}

module.exports = { createReminderScheduler };
