'use strict';

const { msg } = require('./utils');

function createPaywallReminderScheduler({
  bot,
  db,
  intervalMs = process.env.PAYWALL_REMINDER_TICK_MS || 60000,
}) {
  if (!bot || !db) throw new Error('paywall reminder scheduler requires bot and db');
  const interval = Math.max(Number(intervalMs) || 60000, 60000);
  let timer = null;

  async function tick() {
    if (typeof db.listDuePaywallReminders !== 'function' || typeof db.markPaywallReminderSent !== 'function') {
      return;
    }
    try {
      const due = await db.listDuePaywallReminders(new Date(), 100);
      for (const row of due || []) {
        if (!row?.tg_id) {
          await db.markPaywallReminderSent(row.user_id);
          continue;
        }
        await bot.telegram.sendMessage(
          row.tg_id,
          msg('paywall_remind_due') || 'Free case available again. You can send a new photo.',
        );
        await db.markPaywallReminderSent(row.user_id);
      }
    } catch (err) {
      console.error('paywall reminder tick error', err);
    }
  }

  async function start() {
    if (timer) return;
    await tick();
    timer = setInterval(tick, interval);
    if (typeof timer.unref === 'function') timer.unref();
  }

  function stop() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  return { start, stop };
}

module.exports = { createPaywallReminderScheduler };
