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
  const tickInterval = Number(intervalMs || process.env.REMINDER_TICK_MS || 60000);
  let timer = null;
  let running = false;

  async function tick() {
    try {
      const due = await db.dueReminders(new Date());
      for (const reminder of due) {
        try {
          const text = formatReminder(reminder);
          await bot.telegram.sendMessage(reminder.user_tg_id, text);
          await db.markReminderSent(reminder.id);
        } catch (err) {
          console.error('reminder send error', err);
        }
      }
    } catch (err) {
      console.error('reminder tick error', err);
    }
  }

  function start() {
    if (running) return;
    running = true;
    timer = setInterval(tick, tickInterval);
    if (typeof timer.unref === 'function') {
      timer.unref();
    }
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
    running = false;
  }

  return { start, stop, tick };
}

module.exports = { createReminderScheduler };
