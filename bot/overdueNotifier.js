'use strict';

const { msg } = require('./utils');

function createOverdueNotifier({
  bot,
  db,
  intervalMs = process.env.OVERDUE_PUSH_INTERVAL_MS || 3600000,
  thresholdMinutes = process.env.OVERDUE_PUSH_THRESHOLD_MIN || 60,
  cooldownMinutes = process.env.OVERDUE_PUSH_COOLDOWN_MIN || 720,
}) {
  if (!bot || !db) throw new Error('overdue notifier requires bot and db');
  const interval = Math.max(Number(intervalMs) || 3600000, 60000);
  const threshold = Math.max(Number(thresholdMinutes) || 60, 15);
  const cooldown = Math.max(Number(cooldownMinutes) || 720, 60);
  const lastPush = new Map();
  let timer = null;

  async function tick() {
    try {
      if (typeof db.listOverdueUsersSummary !== 'function') return;
      const rows = await db.listOverdueUsersSummary(threshold, 100);
      for (const row of rows) {
        if (!row?.user_tg_id) continue;
        const last = lastPush.get(row.user_id) || 0;
        if (Date.now() - last < cooldown * 60000) continue;
        const text = msg('plans_overdue_push', {
          count: row.overdue_count,
        });
        await bot.telegram.sendMessage(row.user_tg_id, text, {
          reply_markup: {
            inline_keyboard: [[{ text: msg('plans_manage_button'), callback_data: 'plan_my_plans' }]],
          },
        });
        lastPush.set(row.user_id, Date.now());
      }
    } catch (err) {
      console.error('overdue notifier tick error', err);
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

module.exports = { createOverdueNotifier };

