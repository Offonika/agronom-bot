const { msg } = require('./utils');
const { logEvent, buyProHandler, cancelAutopay } = require('./payments');

async function startHandler(ctx, pool) {
  if (ctx.startPayload === 'paywall') {
    await logEvent(pool, ctx.from.id, 'paywall_click_buy');
  } else if (ctx.startPayload === 'faq') {
    await logEvent(pool, ctx.from.id, 'paywall_click_faq');
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
  await ctx.reply('Будем рады вашему отзыву!', {
    reply_markup: {
      inline_keyboard: [[{ text: 'Оставить отзыв', url: url.toString() }]],
    },
  });
}

async function cancelAutopayHandler(ctx) {
  return cancelAutopay(ctx);
}

async function autopayEnableHandler(ctx, pool) {
  return buyProHandler(ctx, pool, 3000, 60000, true);
}

async function askExpertHandler(ctx, pool) {
  const [, ...parts] = ctx.message.text.split(' ');
  const question = parts.join(' ').trim();
  if (!question) {
    return ctx.reply('Укажите вопрос после команды /ask_expert');
  }
  const API_BASE = process.env.API_BASE_URL || 'http://localhost:8000';
  const API_KEY = process.env.API_KEY || 'test-api-key';
  const API_VER = process.env.API_VER || 'v1';
  try {
    await fetch(`${API_BASE}/v1/ask_expert`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': API_KEY,
        'X-API-Ver': API_VER,
        'X-User-ID': ctx.from.id.toString(),
      },
      body: JSON.stringify({ question }),
    });
    if (ctx.from) {
      await logEvent(pool, ctx.from.id, 'ask_expert_command');
    }
    return ctx.reply('Ваш вопрос отправлен эксперту.');
  } catch (err) {
    console.error('ask_expert error', err);
    return ctx.reply('Не удалось отправить вопрос эксперту.');
  }
}

module.exports = {
  startHandler,
  helpHandler,
  feedbackHandler,
  cancelAutopayHandler,
  autopayEnableHandler,
  askExpertHandler,
};
