const { msg, botLink } = require('./utils');
const { sendStartNotice, getDocVersion } = require('./privacyNotice');
const { logEvent, buyProHandler, cancelAutopay } = require('./payments');
const { buildTipsKeyboard } = require('./photoTips');
const { ensureUserWithBeta, isBetaUser } = require('./beta');
const support = require('./support');

const MAIN_MENU_COMMANDS = [
  { command: 'new', labelKey: 'command_new_desc', fallback: 'Новый диагноз' },
  { command: 'objects', labelKey: 'command_objects_desc', fallback: 'Мои растения' },
  { command: 'assistant', labelKey: 'command_assistant_desc', fallback: 'Живой ассистент' },
  { command: 'location', labelKey: 'command_location_desc', fallback: 'Обновить координаты' },
  { command: 'edit', labelKey: 'command_edit_desc', fallback: 'Редактировать растение' },
  { command: 'plans', labelKey: 'command_plans_desc', fallback: 'Мои планы' },
];

function getMainMenuLabel(item) {
  return msg(item.labelKey) || item.fallback;
}

function buildMainMenuKeyboard() {
  const labels = MAIN_MENU_COMMANDS.map(getMainMenuLabel);
  return {
    keyboard: [
      [labels[0], labels[1]],
      [labels[2], labels[3]],
      [labels[4], labels[5]],
    ],
    resize_keyboard: true,
    one_time_keyboard: false,
  };
}

function getMainMenuActions() {
  const actions = {};
  for (const item of MAIN_MENU_COMMANDS) {
    const label = getMainMenuLabel(item);
    if (label) {
      actions[label] = item.command;
    }
  }
  return actions;
}

function emptyUtm() {
  return { source: null, medium: null, campaign: null };
}

function decodeBase64Url(payload) {
  if (!payload || typeof payload !== 'string') return null;
  try {
    const normalized = payload.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
    return Buffer.from(padded, 'base64').toString('utf8');
  } catch (err) {
    return null;
  }
}

function parseCompactUtm(raw) {
  if (!raw || typeof raw !== 'string' || !raw.includes('=')) return emptyUtm();
  const data = { source: null, medium: null, campaign: null };
  let hasValue = false;
  for (const part of raw.split('|')) {
    const [key, ...rest] = part.split('=');
    if (!key || rest.length === 0) continue;
    const value = rest.join('=').trim();
    if (!value) continue;
    if (key === 'src' || key === 'utm_source') {
      data.source = value;
      hasValue = true;
    } else if (key === 'med' || key === 'utm_medium') {
      data.medium = value;
      hasValue = true;
    } else if (key === 'cmp' || key === 'utm_campaign') {
      data.campaign = value;
      hasValue = true;
    }
  }
  return hasValue ? data : emptyUtm();
}

/**
 * Parse UTM parameters from startPayload.
 * Formats:
 * - base64url encoded "src=...|med=...|cmp=..."
 * - src=...|med=...|cmp=...
 * - source_medium_campaign (legacy)
 * @param {string|undefined} payload
 * @returns {{source: string|null, medium: string|null, campaign: string|null}}
 */
function parseUtmPayload(payload) {
  if (!payload || typeof payload !== 'string') {
    return emptyUtm();
  }
  // Skip known payloads
  if (['paywall', 'faq'].includes(payload)) {
    return emptyUtm();
  }
  const direct = parseCompactUtm(payload);
  if (direct.source || direct.medium || direct.campaign) {
    return direct;
  }
  const decoded = decodeBase64Url(payload);
  const decodedUtm = parseCompactUtm(decoded);
  if (decodedUtm.source || decodedUtm.medium || decodedUtm.campaign) {
    return decodedUtm;
  }
  const parts = payload.split('_');
  return {
    source: parts[0] || null,
    medium: parts[1] || null,
    campaign: parts.slice(2).join('_') || null,
  };
}

async function startHandler(ctx, pool, deps = {}) {
  const db = deps.db;
  let dbUser = null;
  const isNewUser = { value: false };

  if (db && ctx.from?.id) {
    try {
      // Check if user exists before ensuring
      const existingUser = typeof db.getUserByTgId === 'function'
        ? await db.getUserByTgId(ctx.from.id)
        : null;
      isNewUser.value = !existingUser;

      dbUser = await ensureUserWithBeta(db, ctx.from.id);

      // Marketing: Set trial period for new users (24h)
      if (isNewUser.value && dbUser && typeof db.setTrialPeriod === 'function') {
        try {
          await db.setTrialPeriod(dbUser.id);
        } catch (err) {
          console.error('setTrialPeriod failed', err);
        }
      }

      // Marketing: Save UTM parameters
      const utm = parseUtmPayload(ctx.startPayload);
      if ((utm.source || utm.medium || utm.campaign) && typeof db.saveUtm === 'function') {
        try {
          await db.saveUtm(dbUser.id, utm);
        } catch (err) {
          console.error('saveUtm failed', err);
        }
      }

      // Log start event with UTM
      if (pool) {
        const eventData = { is_new_user: isNewUser.value };
        if (utm.source) eventData.utm_source = utm.source;
        if (utm.medium) eventData.utm_medium = utm.medium;
        if (utm.campaign) eventData.utm_campaign = utm.campaign;
        await logEvent(pool, ctx.from.id, 'start', eventData);
      }
    } catch (err) {
      console.error('startHandler.ensureUser failed', err);
    }
  }

  const privacyVersion = getDocVersion('privacy');
  const offerVersion = getDocVersion('offer');
  const hasPrivacyConsent =
    dbUser && typeof db.getConsentStatus === 'function'
      ? await db.getConsentStatus(dbUser.id, 'privacy')
      : null;
  const hasOfferConsent =
    dbUser && typeof db.getConsentStatus === 'function'
      ? await db.getConsentStatus(dbUser.id, 'offer')
      : null;
  const needsPrivacyConsent =
    !hasPrivacyConsent ||
    !hasPrivacyConsent.status ||
    hasPrivacyConsent.doc_version !== privacyVersion;
  const needsOfferConsent =
    !hasOfferConsent ||
    !hasOfferConsent.status ||
    hasOfferConsent.doc_version !== offerVersion;
  const needsBaseConsent = needsPrivacyConsent || needsOfferConsent;
  if (needsBaseConsent) {
    await sendStartNotice(ctx);
    return;
  }
  if (ctx.startPayload === 'paywall') {
    await logEvent(pool, ctx.from.id, 'paywall_click_buy');
  } else if (ctx.startPayload === 'faq') {
    await logEvent(pool, ctx.from.id, 'paywall_click_faq');
    const backUrl = botLink(ctx) || 'https://t.me/AgronommAI_bot';
    return ctx.reply(msg('faq_text'), {
      reply_markup: {
        inline_keyboard: [
          [
            { text: msg('faq_buy_button'), callback_data: 'buy_pro' },
            { text: msg('faq_back_button'), url: backUrl },
          ],
        ],
      },
    });
  }

  if (dbUser && isBetaUser(dbUser)) {
    if (!dbUser.beta_onboarded_at && typeof db.updateUserBeta === 'function') {
      await ctx.reply(msg('beta.onboarding'), { reply_markup: buildMainMenuKeyboard() });
      try {
        await db.updateUserBeta(dbUser.id, { betaOnboardedAt: new Date().toISOString() });
      } catch (err) {
        console.error('beta onboarding update failed', err);
      }
      await ctx.reply(msg('beta.indoor_hint'), {
        reply_markup: {
          inline_keyboard: [
            [{ text: msg('beta.indoor_button'), callback_data: 'clarify_crop|indoor' }],
            [{ text: msg('beta.indoor_create_button'), callback_data: 'beta_create_indoor' }],
          ],
        },
      });
      return;
    }
    await ctx.reply(msg('beta.start'), { reply_markup: buildMainMenuKeyboard() });
    return;
  }
  await ctx.reply(msg('start'), { reply_markup: buildMainMenuKeyboard() });
}

function helpHandler(ctx) {
  const policyUrl = process.env.PRIVACY_URL || 'https://agronom.offonika.ru/privacy';
  const offerUrl = process.env.OFFER_URL || 'https://agronom.offonika.ru/offer';
  const text = msg('help', { policy_url: policyUrl, offer_url: offerUrl });
  return ctx.reply(text);
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

async function cancelAutopayHandler(ctx, pool) {
  return cancelAutopay(ctx, pool);
}

async function autopayEnableHandler(ctx, pool) {
  const text = msg('autopay_confirm_text');
  const keyboard = {
    inline_keyboard: [
      [{ text: msg('autopay_confirm_button'), callback_data: 'autopay_confirm' }],
      [{ text: msg('autopay_cancel_button'), callback_data: 'autopay_cancel' }],
    ],
  };
  return ctx.reply(text, { reply_markup: keyboard });
}

async function newDiagnosisHandler(ctx) {
  const keyboard = buildTipsKeyboard();
  const opts = keyboard ? { reply_markup: keyboard } : undefined;
  await ctx.reply(msg('new_command_hint'), opts);
}

async function supportHandler(ctx) {
  return support.start(ctx);
}

async function menuHandler(ctx) {
  await ctx.reply(msg('menu_prompt') || 'Меню', { reply_markup: buildMainMenuKeyboard() });
}

module.exports = {
  startHandler,
  helpHandler,
  feedbackHandler,
  cancelAutopayHandler,
  autopayEnableHandler,
  newDiagnosisHandler,
  supportHandler,
  menuHandler,
  buildMainMenuKeyboard,
  getMainMenuActions,
};
