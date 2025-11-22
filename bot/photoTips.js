const { msg } = require('./utils');
const { list } = require('./i18n');

const MAX_TRACKED_USERS = 2000;
const tipsShown = new Set();
const hintsSent = new Set();

function remember(set, key) {
  if (!key) return;
  if (set.has(key)) return;
  if (set.size >= MAX_TRACKED_USERS) {
    const oldest = set.values().next().value;
    if (oldest !== undefined) {
      set.delete(oldest);
    }
  }
  set.add(key);
}

function buildTipsKeyboard() {
  const text = msg('photo_tips.button');
  if (!text) return null;
  return { inline_keyboard: [[{ text, callback_data: 'photo_tips' }]] };
}

async function sendTips(ctx, opts = {}) {
  const { force = false } = opts;
  if (!ctx?.reply) return false;
  const userId = ctx.from?.id;
  if (!force && userId && tipsShown.has(userId)) {
    const already = msg('photo_tips.already_sent');
    if (already) {
      if (typeof ctx.answerCbQuery === 'function') {
        try {
          await ctx.answerCbQuery(already);
        } catch {
          // ignore answer errors
        }
      } else {
        await ctx.reply(already);
      }
    }
    return false;
  }
  if (userId) remember(tipsShown, userId);

  const intro = msg('photo_tips.intro');
  if (intro) {
    await ctx.reply(intro);
  }
  const cards = list('photo_tips.cards');
  for (const card of cards) {
    if (card) {
      await ctx.reply(card);
    }
  }
  const light = msg('photo_tips.light');
  if (light) {
    await ctx.reply(light);
  }
  if (typeof ctx.answerCbQuery === 'function') {
    try {
      await ctx.answerCbQuery();
    } catch {
      // ignore answer errors
    }
  }
  return true;
}

async function offerHint(ctx) {
  if (!ctx?.reply) return false;
  const userId = ctx.from?.id;
  if (!userId) return false;
  if (hintsSent.has(userId)) return false;
  remember(hintsSent, userId);
  const hint = msg('photo_tips.hint');
  const keyboard = buildTipsKeyboard();
  if (!hint || !keyboard) return false;
  await ctx.reply(hint, { reply_markup: keyboard });
  return true;
}

module.exports = {
  sendTips,
  offerHint,
  buildTipsKeyboard,
};
