const { msg } = require('./utils');

const API_BASE = process.env.API_BASE_URL || 'http://localhost:8000';
const API_KEY = process.env.API_KEY || 'test-api-key';
const API_VER = process.env.API_VER || 'v1';

function paywallEnabled() {
  return process.env.PAYWALL_ENABLED !== 'false';
}

function getLimit() {
  return parseInt(process.env.FREE_PHOTO_LIMIT || '5', 10);
}

async function logEvent(pool, userId, ev) {
  if (!pool) return;
  try {
    await pool.query('INSERT INTO events (user_id, event) VALUES ($1, $2)', [userId, ev]);
  } catch (err) {
    console.error('event log error', err);
  }
}

async function sendPaywall(ctx, pool) {
  if (!paywallEnabled()) {
    return;
  }
  if (ctx.from) {
    await logEvent(pool, ctx.from.id, 'paywall_shown');
  }
  const limit = getLimit();
  return ctx.reply(msg('paywall', { limit }), {
    reply_markup: {
      inline_keyboard: [
        [
          { text: 'Купить PRO', callback_data: 'buy_pro' },
          { text: 'Подробнее', url: 'https://t.me/YourBot?start=faq' },
        ],
      ],
    },
  });
}

async function buyProHandler(ctx, pool, intervalMs = 3000) {
  await ctx.answerCbQuery();
  if (ctx.from) {
    await logEvent(pool, ctx.from.id, 'paywall_click_buy');
  }
  try {
    const resp = await fetch(`${API_BASE}/v1/payments/create`, {
      method: 'POST',
      headers: {
        'X-API-Key': API_KEY,
        'X-API-Ver': API_VER,
        'X-User-ID': ctx.from?.id,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ user_id: ctx.from.id, plan: 'pro', months: 1 }),
    });
    const data = await resp.json();
    ctx.paymentId = data.payment_id;
    const reply = ctx.reply(msg('payment_prompt'), {
      reply_markup: {
        inline_keyboard: [[{ text: msg('payment_button'), url: data.url }]],
      },
    });
    if (intervalMs > 0) {
      ctx.pollPromise = pollPaymentStatus(ctx, data.payment_id, intervalMs).catch((e) =>
        console.error('poll error', e),
      );
    }
    return reply;
  } catch (err) {
    console.error('payment error', err);
    return ctx.reply(msg('payment_error'));
  }
}

async function pollPaymentStatus(ctx, paymentId, intervalMs = 3000) {
  for (let i = 0; i < 20; i += 1) {
    await new Promise((r) => setTimeout(r, intervalMs));
    try {
      const resp = await fetch(`${API_BASE}/v1/payments/${paymentId}`, {
        headers: {
          'X-API-Key': API_KEY,
          'X-API-Ver': API_VER,
          'X-User-ID': ctx.from?.id,
        },
      });
      if (!resp.ok) continue;
      const data = await resp.json();
      if (['success', 'fail', 'cancel'].includes(data.status)) {
        if (data.status === 'success') {
          const dt = new Date(data.pro_expires_at);
          const date = dt.toLocaleDateString('ru-RU');
          await ctx.reply(msg('payment_success', { date }));
        } else {
          await ctx.reply(msg('payment_fail'));
        }
        break;
      }
    } catch (e) {
      console.error('status check error', e);
    }
  }
}

async function subscribeHandler(ctx, pool) {
  return sendPaywall(ctx, pool);
}

module.exports = {
  buyProHandler,
  pollPaymentStatus,
  subscribeHandler,
  sendPaywall,
  logEvent,
  paywallEnabled,
  getLimit,
};
