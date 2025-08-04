const { msg } = require('./utils');

const reminders = new Map();
let nextId = 1;

async function reminderHandler(ctx) {
  const uid = ctx.from && ctx.from.id;
  if (!uid) return ctx.reply(msg('reminder_error'));

  const data = ctx.callbackQuery && ctx.callbackQuery.data;

  if (!data) {
    return ctx.reply(msg('reminder_prompt'), {
      reply_markup: {
        inline_keyboard: [
          [{ text: msg('reminder_add_button'), callback_data: 'remind_add' }],
          [{ text: msg('reminder_list_button'), callback_data: 'remind_list' }],
        ],
      },
    });
  }

  await ctx.answerCbQuery();

  if (data === 'remind_add') {
    const id = nextId++;
    const timeout = setTimeout(async () => {
      try {
        await ctx.reply(msg('reminder_due'));
      } catch {}
      const arr = reminders.get(uid) || [];
      const idx = arr.findIndex((r) => r.id === id);
      if (idx >= 0) arr.splice(idx, 1);
    }, 60 * 60 * 1000);
    timeout.unref();
    const arr = reminders.get(uid) || [];
    arr.push({ id, timeout });
    reminders.set(uid, arr);
    return ctx.reply(msg('reminder_created'));
  }

  if (data === 'remind_list') {
    const arr = reminders.get(uid) || [];
    if (!arr.length) return ctx.reply(msg('reminder_none'));
    return ctx.reply(msg('reminder_list_title'), {
      reply_markup: {
        inline_keyboard: arr.map((r) => [
          {
            text: `${msg('reminder_cancel_button')} ${r.id}`,
            callback_data: `remind_cancel|${r.id}`,
          },
        ]),
      },
    });
  }

  if (data.startsWith('remind_cancel|')) {
    const [, idStr] = data.split('|');
    const id = Number(idStr);
    const arr = reminders.get(uid) || [];
    const idx = arr.findIndex((r) => r.id === id);
    if (idx >= 0) {
      clearTimeout(arr[idx].timeout);
      arr.splice(idx, 1);
      reminders.set(uid, arr);
      return ctx.reply(msg('reminder_cancelled'));
    }
    return ctx.reply(msg('reminder_none'));
  }

  return ctx.reply(msg('reminder_error'));
}

module.exports = { reminderHandler, reminders };
