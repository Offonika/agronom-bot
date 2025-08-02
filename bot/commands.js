const { msg } = require('./utils');
const { logEvent, sendPaywall } = require('./payments');

function startHandler(ctx, pool) {
  if (ctx.startPayload === 'paywall') {
    logEvent(pool, ctx.from.id, 'paywall_click_buy');
  } else if (ctx.startPayload === 'faq') {
    logEvent(pool, ctx.from.id, 'paywall_click_faq');
  }
  ctx.reply(msg('start'));
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

function feedbackHandler(ctx, pool) {
  const base = process.env.FEEDBACK_URL || 'https://example.com/feedback';
  const url = new URL(base);
  url.searchParams.set('utm_source', 'telegram');
  url.searchParams.set('utm_medium', 'bot');
  url.searchParams.set('utm_campaign', 'feedback');
  if (ctx.from) {
    logEvent(pool, ctx.from.id, 'feedback_open');
  }
  return ctx.reply('Будем рады вашему отзыву!', {
    reply_markup: {
      inline_keyboard: [[{ text: 'Оставить отзыв', url: url.toString() }]],
    },
  });
}

module.exports = { startHandler, helpHandler, feedbackHandler };
