const { msg, botLink } = require('./utils');
const { sendConsentScreen, getDocVersion } = require('./privacyNotice');
const { buildApiHeaders } = require('./apiAuth');
const { createDb } = require('../services/db');

const API_BASE = process.env.API_BASE_URL || 'http://localhost:8010';
const inFlightPayments = new Map();
function paywallEnabled() {
  return process.env.PAYWALL_ENABLED !== 'false';
}

function sbpQrEnabled() {
  const raw = (process.env.SBP_QR_ENABLED || '').toLowerCase();
  return ['1', 'true', 'yes', 'on'].includes(raw);
}

function getLimit() {
  const limit = parseInt(process.env.FREE_PHOTO_LIMIT, 10);
  return Number.isNaN(limit) ? 5 : limit;
}

function normalizeDays(value) {
  const parsed = parseInt(value, 10);
  if (Number.isNaN(parsed)) return null;
  return Math.min(Math.max(parsed, 1), 30);
}

async function logEvent(pool, userId, ev, data = {}) {
  if (!pool) return;
  try {
    const utmSource = data.utm_source || data.utmSource || null;
    const utmMedium = data.utm_medium || data.utmMedium || null;
    const utmCampaign = data.utm_campaign || data.utmCampaign || null;
    await pool.query(
      'INSERT INTO analytics_events (user_id, event, utm_source, utm_medium, utm_campaign) VALUES ($1, $2, $3, $4, $5)',
      [userId, ev, utmSource, utmMedium, utmCampaign],
    );
  } catch (err) {
    console.error('event log error', err);
  }
}

function buildSubscribeKeyboard(ctx, opts = {}) {
  const faqUrl =
    opts.faqUrl ||
    process.env.BOT_FAQ_URL ||
    botLink(ctx, '?start=faq') ||
    'https://t.me/AgronommAI_bot?start=faq';
  const rows = [];
  const buyOnceLabel =
    opts.buyOnceLabel ||
    msg('subscribe_buy_once_button') ||
    '🛒 Купить PRO на месяц — 199 ₽';
  rows.push([
    {
      text: buyOnceLabel,
      callback_data: 'buy_pro',
    },
  ]);
  rows.push([
    {
      text: msg('subscribe_buy_autopay_button') || '🔁 Купить PRO с автопродлением — 199 ₽/мес',
      callback_data: 'autopay_enable',
    },
  ]);
  if (opts.includeCancel) {
    rows.push([
      {
        text: msg('subscribe_cancel_autopay_button') || 'Отключить автопродление',
        callback_data: 'cancel_autopay',
      },
    ]);
  }
  if (faqUrl) {
    rows.push([{ text: msg('subscribe_more_button') || 'ℹ️ Подробнее', url: faqUrl }]);
  }
  if (opts.includeBack) {
    rows.push([
      {
        text: msg('subscribe_back_button') || '⬅️ Назад',
        callback_data: 'subscribe_back',
      },
    ]);
  }
  return { inline_keyboard: rows };
}

function buildPaywallKeyboard({ remindDays } = {}) {
  const rows = [];
  rows.push([
    {
      text: msg('paywall_try_pro_button') || '✨ Попробовать Pro',
      callback_data: 'buy_pro',
    },
  ]);
  if (remindDays) {
    rows.push([
      {
        text:
          msg('paywall_remind_button', { days: remindDays }) ||
          `⏰ Напомнить через ${remindDays} дн.`,
        callback_data: `paywall_remind|${remindDays}`,
      },
    ]);
  }
  return { inline_keyboard: rows };
}

function buildIdempotencyKey(ctx, autopay) {
  const userId = ctx?.from?.id || 'anon';
  const messageId =
    ctx?.callbackQuery?.message?.message_id ||
    ctx?.message?.message_id ||
    ctx?.callbackQuery?.id ||
    Date.now();
  const kind = autopay ? 'autopay' : 'once';
  return `pay:${kind}:${userId}:${messageId}`;
}

async function sendPaywall(ctx, pool, info = {}) {
  if (!paywallEnabled()) {
    return;
  }
  if (ctx.from) {
    await logEvent(pool, ctx.from.id, 'paywall_shown');
  }
  const limitType = info?.limit_type || info?.limitType || null;
  const resetInDays =
    normalizeDays(info?.reset_in_days ?? info?.resetInDays) || null;
  const limitRaw = info?.limit ?? info?.limitValue;
  const limit = Number.isFinite(Number(limitRaw)) ? Number(limitRaw) : getLimit();
  const isWeekly = limitType === 'weekly_cases' || Boolean(resetInDays);
  const days = resetInDays || 7;
  const text = isWeekly ? msg('paywall_weekly', { days }) : msg('paywall', { limit });
  const replyMarkup = isWeekly
    ? buildPaywallKeyboard({ remindDays: days })
    : buildSubscribeKeyboard(ctx, { includeCancel: false });
  return ctx.reply(text, { reply_markup: replyMarkup });
}

async function sendAssistantPaywall(ctx, pool) {
  if (!paywallEnabled()) {
    return false;
  }
  if (ctx.from) {
    await logEvent(pool, ctx.from.id, 'assistant_paywall_shown');
  }
  const text = msg('paywall_assistant') || msg('paywall') || 'Подписка и оплата';
  await ctx.reply(text, {
    reply_markup: buildPaywallKeyboard(),
  });
  return true;
}

async function handlePaywallRemind(ctx, pool) {
  if (typeof ctx.answerCbQuery === 'function' && ctx.callbackQuery) {
    await ctx.answerCbQuery();
  }
  const data = ctx.callbackQuery?.data || '';
  const [, daysRaw] = data.split('|');
  const days = normalizeDays(daysRaw) || 3;
  const db = resolveDb(pool);
  const user = await resolveApiUser(pool, ctx);
  if (!db?.upsertPaywallReminder || !user?.id) {
    if (typeof ctx.reply === 'function') {
      await ctx.reply(msg('payment_error'));
    }
    return;
  }
  const fireAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  try {
    await db.upsertPaywallReminder(user.id, fireAt);
  } catch (err) {
    console.error('paywall reminder save failed', err);
    if (typeof ctx.reply === 'function') {
      await ctx.reply(msg('payment_error'));
    }
    return;
  }
  if (ctx.from) {
    await logEvent(pool, ctx.from.id, 'paywall_remind', { days });
  }
  if (typeof ctx.reply === 'function') {
    await ctx.reply(
      msg('paywall_remind_ok', { days }) ||
        `Хорошо, напомню через ${days} дн.`,
    );
  }
}

function normalizePool(pool) {
  if (!pool) return null;
  if (typeof pool.connect === 'function' && typeof pool.end === 'function') return pool;
  if (typeof pool.query === 'function') {
    return {
      ...pool,
      connect: async () => pool,
      end: async () => {},
    };
  }
  return null;
}

function resolveDb(pool) {
  const normalized = normalizePool(pool);
  if (!normalized) return null;
  try {
    return createDb(normalized);
  } catch (err) {
    console.error('createDb failed', err);
    return null;
  }
}

async function resolveApiUser(pool, ctx) {
  if (!pool || !ctx?.from?.id) return null;
  if (typeof pool.ensureUser === 'function') {
    try {
      return await pool.ensureUser(ctx.from.id);
    } catch (err) {
      console.error('ensureUser failed', err);
      return null;
    }
  }
  const normalized = normalizePool(pool);
  if (!normalized) return null;
  const db = createDb(normalized);
  if (!db?.ensureUser) return null;
  try {
    return await db.ensureUser(ctx.from.id);
  } catch (err) {
    console.error('ensureUser failed', err);
    return null;
  }
}

async function buyProHandler(
  ctx,
  pool,
  intervalMs = 3000,
  timeoutMs = 60000,
  autopay = false,
) {
  if (typeof ctx.answerCbQuery === 'function' && ctx.callbackQuery) {
    await ctx.answerCbQuery();
  }
  const userKey = ctx?.from?.id ? String(ctx.from.id) : null;
  if (userKey) {
    const lastAt = inFlightPayments.get(userKey);
    if (lastAt && Date.now() - lastAt < 10000) {
      if (typeof ctx.answerCbQuery === 'function' && ctx.callbackQuery) {
        await ctx.answerCbQuery('Запрос уже обрабатывается', { show_alert: false });
      }
      return;
    }
    inFlightPayments.set(userKey, Date.now());
  }
  if (ctx.from) {
    await logEvent(pool, ctx.from.id, 'paywall_click_buy');
  }
  try {
    const user = await resolveApiUser(pool, ctx);
    if (!user?.api_key) {
      return await ctx.reply(msg('payment_error'));
    }
    const normalized = normalizePool(pool);
    if (normalized) {
      const db = createDb(normalized);
      if (typeof db.getConsentStatus === 'function') {
        const privacyConsent = await db.getConsentStatus(user.id, 'privacy');
        const offerConsent = await db.getConsentStatus(user.id, 'offer');
        const privacyVersion = getDocVersion('privacy');
        const offerVersion = getDocVersion('offer');
        const privacyOk =
          privacyConsent &&
          privacyConsent.status &&
          privacyConsent.doc_version === privacyVersion;
        const offerOk =
          offerConsent && offerConsent.status && offerConsent.doc_version === offerVersion;
        if (!privacyOk || !offerOk) {
          const callback = `consent_accept|all|pay|${autopay ? '1' : '0'}`;
          await sendConsentScreen(ctx, { acceptCallback: callback });
          return;
        }
      }
    }
    const payload = { user_id: user.id, plan: 'pro', months: 1, autopay };
    const idempotencyKey = buildIdempotencyKey(ctx, autopay);
    const resp = await fetch(`${API_BASE}/v1/payments/create`, {
      method: 'POST',
      headers: {
        ...buildApiHeaders({
          apiKey: user.api_key,
          userId: user.id,
          method: 'POST',
          path: '/v1/payments/create',
          body: payload,
        }),
        'Idempotency-Key': idempotencyKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    if (resp.status === 403) {
      let detail = null;
      try {
        detail = await resp.json();
      } catch {
        detail = null;
      }
      if (detail?.detail?.message === 'CONSENT_REQUIRED') {
        const callback = `consent_accept|all|pay|${autopay ? '1' : '0'}`;
        await sendConsentScreen(ctx, { acceptCallback: callback });
        return;
      }
    }
    if (!resp.ok) {
      console.error('payment create error', resp.status);
      return await ctx.reply(msg('payment_error'));
    }
    const data = await resp.json();
    ctx.paymentId = data.payment_id;
    const cardLabel = msg('payment_button_card') || msg('payment_button') || 'Оплатить картой';
    const sbpLabel = msg('payment_button_sbp') || 'Оплатить через СБП';
    const buttons = [];
    if (sbpQrEnabled() && data.sbp_url) {
      buttons.push({ text: sbpLabel, url: data.sbp_url });
    }
    buttons.push({ text: cardLabel, url: data.url });
    const reply = await ctx.reply(msg('payment_prompt'), {
      reply_markup: {
        inline_keyboard: buttons.map((btn) => [btn]),
      },
    });
    if (intervalMs > 0) {
      if (ctx.pollController) {
        ctx.pollController.abort();
      }
      const controller = new AbortController();
      ctx.pollController = controller;
      ctx.pollPromise = pollPaymentStatus(
        ctx,
        data.payment_id,
        user,
        intervalMs,
        timeoutMs,
        controller.signal,
      )
        .catch((e) => {
          if (!controller.signal.aborted) {
            console.error('poll error', e);
          }
        })
        .finally(() => {
          if (ctx.pollController === controller) {
            ctx.pollPromise = null;
            ctx.pollController = null;
          }
        });
    }
    return reply;
  } catch (err) {
    console.error('payment error', err);
    return await ctx.reply(msg('payment_error'));
  } finally {
    if (userKey) {
      inFlightPayments.delete(userKey);
    }
  }
}

async function cancelAutopay(ctx, pool) {
  try {
    const user = await resolveApiUser(pool, ctx);
    if (!user?.api_key) {
      return ctx.reply(msg('autopay_cancel_error'));
    }
    const sessionResp = await fetch(`${API_BASE}/v1/auth/token`, {
      headers: buildApiHeaders({
        apiKey: user.api_key,
        userId: user.id,
        method: 'GET',
        path: '/v1/auth/token',
      }),
    });
    if (!sessionResp.ok) {
      return ctx.reply(msg('autopay_cancel_error'));
    }
    const { jwt, csrf } = await sessionResp.json();

    const payload = { user_id: user.id };
    const resp = await fetch(`${API_BASE}/v1/payments/sbp/autopay/cancel`, {
      method: 'POST',
      headers: {
        ...buildApiHeaders({
          apiKey: user.api_key,
          userId: user.id,
          method: 'POST',
          path: '/v1/payments/sbp/autopay/cancel',
          body: payload,
        }),
        'Content-Type': 'application/json',
        Authorization: `Bearer ${jwt}`,
        'X-CSRF-Token': csrf,
      },
      body: JSON.stringify(payload),
    });
    if (resp.status === 401 || resp.status === 403) {
      return ctx.reply(msg('error_UNAUTHORIZED'));
    }
    if (resp.ok) {
      const normalized = normalizePool(pool);
      if (normalized) {
        const db = createDb(normalized);
        if (typeof db.revokeConsent === 'function') {
          await db.revokeConsent(
            user.id,
            'autopay',
            getDocVersion('autopay'),
            'bot',
            { reason: 'user_cancel' },
          );
        }
      }
      return ctx.reply(msg('autopay_cancel_success'));
    }
    return ctx.reply(msg('autopay_cancel_error'));
  } catch (err) {
    console.error('autopay cancel error', err);
    return ctx.reply(msg('autopay_cancel_error'));
  }
}

async function pollPaymentStatus(
  ctx,
  paymentId,
  user,
  intervalMs = 3000,
  timeoutMs = 60000,
  signal,
) {
  if (!user?.api_key) {
    await ctx.reply(msg('payment_error'));
    return;
  }
  const maxAttempts = Math.max(1, Math.floor(timeoutMs / intervalMs));
  const delay = (ms) =>
    new Promise((resolve, reject) => {
      const t = setTimeout(resolve, ms);
      if (signal) {
        signal.addEventListener(
          'abort',
          () => {
            clearTimeout(t);
            reject(new Error('aborted'));
          },
          { once: true },
        );
      }
    });
  for (let i = 0; i < maxAttempts; i += 1) {
    try {
      await delay(intervalMs);
    } catch {
      return;
    }
    if (signal?.aborted) return;
    try {
      const resp = await fetch(`${API_BASE}/v1/payments/${paymentId}`, {
        headers: buildApiHeaders({
          apiKey: user.api_key,
          userId: user.id,
          method: 'GET',
          path: `/v1/payments/${paymentId}`,
        }),
        signal,
      });
      if (!resp.ok) continue;
      const data = await resp.json();
      if (['success', 'fail', 'cancel', 'bank_error'].includes(data.status)) {
        if (data.status === 'success') {
          const dt = new Date(data.pro_expires_at);
          const date = dt.toLocaleDateString('ru-RU');
          await ctx.reply(msg('payment_success', { date }));
        } else {
          await ctx.reply(msg('payment_fail'));
        }
        return;
      }
    } catch (e) {
      if (!signal?.aborted) {
        console.error('status check error', e);
      }
    }
  }
  if (!signal?.aborted) {
    await ctx.reply(msg('payment_pending'));
  }
}

async function subscribeHandler(ctx, pool) {
  if (ctx.from) {
    await logEvent(pool, ctx.from.id, 'subscribe_opened');
  }
  let autopayEnabled = false;
  let hasConsents = true;
  let proExpiresAt = null;
  const user = await resolveApiUser(pool, ctx);
  const normalized = normalizePool(pool);
  if (user && normalized) {
    autopayEnabled = !!user.autopay_enabled;
    proExpiresAt = user.pro_expires_at || null;
    const db = createDb(normalized);
    if (typeof db.getConsentStatus === 'function') {
      const privacyConsent = await db.getConsentStatus(user.id, 'privacy');
      const offerConsent = await db.getConsentStatus(user.id, 'offer');
      const privacyVersion = getDocVersion('privacy');
      const offerVersion = getDocVersion('offer');
      const privacyOk =
        privacyConsent &&
        privacyConsent.status &&
        privacyConsent.doc_version === privacyVersion;
      const offerOk =
        offerConsent && offerConsent.status && offerConsent.doc_version === offerVersion;
      hasConsents = privacyOk && offerOk;
    }
  }
  if (!hasConsents) {
    await sendConsentScreen(ctx, { acceptCallback: 'consent_accept|all|subscribe' });
    return;
  }
  let text = msg('subscribe_prompt') || 'Подписка и оплата';
  let buyOnceLabel = null;
  const now = Date.now();
  if (proExpiresAt) {
    const dt = new Date(proExpiresAt);
    if (!Number.isNaN(dt.getTime()) && dt.getTime() > now) {
      const date = dt.toLocaleDateString('ru-RU');
      text =
        msg('subscribe_active_prompt', { date }) ||
        `Сейчас PRO активен до ${date}. Хотите продлить?`;
      buyOnceLabel =
        msg('subscribe_extend_button') || '🔁 Продлить PRO на месяц — 199 ₽';
    }
  }
  return ctx.reply(text, {
    reply_markup: buildSubscribeKeyboard(ctx, {
      includeCancel: autopayEnabled,
      includeBack: true,
      buyOnceLabel,
    }),
  });
}

module.exports = {
  buyProHandler,
  pollPaymentStatus,
  subscribeHandler,
  sendPaywall,
  sendAssistantPaywall,
  handlePaywallRemind,
  logEvent,
  paywallEnabled,
  getLimit,
  cancelAutopay,
};
