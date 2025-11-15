const { msg } = require('./utils');
const { logEvent, buyProHandler, cancelAutopay } = require('./payments');

async function startHandler(ctx, pool) {
  if (ctx.startPayload === 'paywall') {
    await logEvent(pool, ctx.from.id, 'paywall_click_buy');
  } else if (ctx.startPayload === 'faq') {
    await logEvent(pool, ctx.from.id, 'paywall_click_faq');
    return ctx.reply(msg('faq_text'), {
      reply_markup: {
        inline_keyboard: [
          [
            { text: msg('faq_buy_button'), callback_data: 'buy_pro' },
            { text: msg('faq_back_button'), url: 'https://t.me/YourBot' },
          ],
        ],
      },
    });
  }
  await ctx.reply(msg('start'));
}

function helpHandler(ctx) {
  const policyUrl =
    process.env.PRIVACY_URL ||
    'https://github.com/your-org/agronom-bot/blob/main/docs/privacy_policy.md';
  const offerUrl =
    process.env.OFFER_URL ||
    'https://github.com/your-org/agronom-bot/blob/main/docs/public_offer.md';
  const text = msg('help', { policy_url: policyUrl, offer_url: offerUrl });
  return ctx.reply(text, {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [[{ text: msg('privacy_button'), url: policyUrl }], [{ text: msg('offer_button'), url: offerUrl }]],
    },
  });
}

async function feedbackHandler(ctx, pool) {
  const base = process.env.FEEDBACK_URL || 'https://example.com/feedback';
  const url = new URL(base);
  url.searchParams.set('utm_source', 'telegram');
  url.searchParams.set('utm_medium', 'bot');
  url.searchParams.set('utm_campaign', 'feedback');
  if (ctx.from) {
    await logEvent(pool, ctx.from.id, 'feedback_open');
  }
  await ctx.reply(msg('feedback_text'), {
    reply_markup: {
      inline_keyboard: [[{ text: msg('feedback_button'), url: url.toString() }]],
    },
  });
}

async function cancelAutopayHandler(ctx) {
  return cancelAutopay(ctx);
}

async function autopayEnableHandler(ctx, pool) {
  return buyProHandler(ctx, pool, 3000, 60000, true);
}

async function newDiagnosisHandler(ctx) {
  await ctx.reply(msg('new_command_hint'));
}

module.exports = {
  startHandler,
  helpHandler,
  feedbackHandler,
  cancelAutopayHandler,
  autopayEnableHandler,
  newDiagnosisHandler,
};
