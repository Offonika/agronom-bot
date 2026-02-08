'use strict';

const { msg } = require('./utils');

const USER_ERROR_CODES = {
  LOW_CONFIDENCE: {
    textKey: 'error_low_confidence',
    keyboard: () => [[{ text: msg('error_low_confidence_button'), callback_data: 'reshoot_photo' }]],
  },
  NO_RECENT_DIAGNOSIS: {
    textKey: 'error_no_recent_diagnosis',
    keyboard: () => [[{ text: msg('error_no_recent_diagnosis_button'), callback_data: 'plan_recent_new' }]],
  },
  BUTTON_EXPIRED: {
    textKey: 'error_button_expired',
    keyboard: () => [
      [{ text: msg('error_button_expired_button'), callback_data: 'plan_recent_new' }],
      [{ text: msg('error_plan_not_found_button'), callback_data: 'plan_error_plans' }],
    ],
  },
  SESSION_EXPIRED: {
    textKey: 'error_session_expired',
    keyboard: () => [
      [{ text: msg('error_session_expired_button'), callback_data: 'plan_recent_new' }],
      [{ text: msg('error_plan_not_found_button'), callback_data: 'plan_error_plans' }],
    ],
  },
  OBJECT_NOT_OWNED: {
    textKey: 'error_object_not_owned',
    keyboard: () => [[{ text: msg('error_object_not_owned_button'), callback_data: 'plan_error_objects' }]],
  },
  PLAN_NOT_FOUND: {
    textKey: 'error_plan_not_found',
    keyboard: () => [[{ text: msg('error_plan_not_found_button'), callback_data: 'plan_error_plans' }]],
  },
  OBJECT_NOT_FOUND: {
    textKey: 'error_object_not_found',
    keyboard: () => [[{ text: msg('error_object_not_found_button'), callback_data: 'plan_error_objects' }]],
  },
  PRODUCT_FORBIDDEN: {
    textKey: 'error_product_forbidden',
    keyboard: () => [[{ text: msg('error_product_forbidden_button'), callback_data: 'plan_error_plans' }]],
  },
  PHI_CONFLICT: {
    textKey: 'error_phi_conflict',
    keyboard: () => [[{ text: msg('error_phi_conflict_button'), callback_data: 'plan_error_plans' }]],
  },
  WEATHER_UNAVAILABLE: {
    textKey: 'error_weather_unavailable',
    keyboard: () => [[{ text: msg('error_weather_unavailable_button'), callback_data: 'plan_error_plans' }]],
  },
};

async function replyUserError(ctx, code, params = {}) {
  const config = USER_ERROR_CODES[code];
  if (!config || typeof ctx?.reply !== 'function') return;
  const text = msg(config.textKey, params);
  let replyMarkup;
  if (typeof config.keyboard === 'function') {
    const rows = config.keyboard(params);
    if (rows?.length) {
      replyMarkup = { inline_keyboard: rows };
    }
  } else if (Array.isArray(config.keyboard) && config.keyboard.length) {
    replyMarkup = { inline_keyboard: config.keyboard };
  }
  const opts = replyMarkup ? { reply_markup: replyMarkup } : undefined;
  await ctx.reply(text, opts);
}

module.exports = { replyUserError, USER_ERROR_CODES };
