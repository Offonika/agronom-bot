"use strict";

const { msg } = require('../utils');
const { replyUserError } = require('../userErrors');
const {
  rememberLocationRequest,
  clearLocationRequest,
} = require('../locationSession');

function parsePayload(data, prefix) {
  if (!data?.startsWith(prefix)) return null;
  const [, id] = data.split('|');
  const objectId = Number(id);
  return Number.isFinite(objectId) && objectId > 0 ? objectId : null;
}

function createPlanLocationHandler({ db }) {
  if (!db) throw new Error('planLocation handler requires db');

  async function confirm(ctx) {
    const objectId = parsePayload(ctx.callbackQuery?.data, 'plan_location_confirm');
    if (!objectId) {
      await safeAnswer(ctx, 'location_error', true);
      await replyUserError(ctx, 'BUTTON_EXPIRED');
      return;
    }
    try {
      const user = await db.ensureUser(ctx.from?.id);
      const object = await db.getObjectById(objectId);
      if (!validateOwnership(object, user?.id)) {
        await safeAnswer(ctx, 'location_error', true);
        await replyUserError(ctx, 'OBJECT_NOT_OWNED');
        return;
      }
      if (typeof db.updateObjectMeta === 'function') {
        await db.updateObjectMeta(objectId, {
          location_confirmed: true,
          location_prompted: true,
          location_source: object.meta?.location_source || 'manual',
          location_confirmed_at: new Date().toISOString(),
        });
      }
      await safeAnswer(ctx, 'location_confirmed_toast');
    } catch (err) {
      console.error('plan_location.confirm error', err);
      await safeAnswer(ctx, 'location_error', true);
    }
  }

  async function change(ctx) {
    const objectId = parsePayload(ctx.callbackQuery?.data, 'plan_location_change');
    if (!objectId) {
      await safeAnswer(ctx, 'location_error', true);
      await replyUserError(ctx, 'BUTTON_EXPIRED');
      return;
    }
    try {
      const user = await db.ensureUser(ctx.from?.id);
      const object = await db.getObjectById(objectId);
      if (!validateOwnership(object, user?.id)) {
        await safeAnswer(ctx, 'location_error', true);
        await replyUserError(ctx, 'OBJECT_NOT_OWNED');
        return;
      }
      await safeAnswer(ctx, 'location_change_hint');
      await ctx.reply(msg('location_manual_prompt_short', { name: object.name }), {
        reply_markup: buildManualKeyboard(object.id),
      });
    } catch (err) {
      console.error('plan_location.change error', err);
      await safeAnswer(ctx, 'location_error', true);
    }
  }

  async function requestGeo(ctx) {
    const objectId = parsePayload(ctx.callbackQuery?.data, 'plan_location_geo');
    if (!objectId) {
      await safeAnswer(ctx, 'location_error', true);
      await replyUserError(ctx, 'BUTTON_EXPIRED');
      return;
    }
    try {
      const user = await db.ensureUser(ctx.from?.id);
      const object = await db.getObjectById(objectId);
      if (!validateOwnership(object, user?.id)) {
        await safeAnswer(ctx, 'location_error', true);
        await replyUserError(ctx, 'OBJECT_NOT_OWNED');
        return;
      }
      rememberLocationRequest(user.id, object.id, 'geo');
      await safeAnswer(ctx, 'location_geo_toast');
      await ctx.reply(msg('location_geo_instructions'));
    } catch (err) {
      console.error('plan_location.geo error', err);
      await safeAnswer(ctx, 'location_error', true);
    }
  }

  async function requestAddress(ctx) {
    const objectId = parsePayload(ctx.callbackQuery?.data, 'plan_location_address');
    if (!objectId) {
      await safeAnswer(ctx, 'location_error', true);
      await replyUserError(ctx, 'BUTTON_EXPIRED');
      return;
    }
    try {
      const user = await db.ensureUser(ctx.from?.id);
      const object = await db.getObjectById(objectId);
      if (!validateOwnership(object, user?.id)) {
        await safeAnswer(ctx, 'location_error', true);
        await replyUserError(ctx, 'OBJECT_NOT_OWNED');
        return;
      }
      rememberLocationRequest(user.id, object.id, 'address');
      await safeAnswer(ctx, 'location_address_toast');
      await ctx.reply(msg('location_address_instructions'));
    } catch (err) {
      console.error('plan_location.address error', err);
      await safeAnswer(ctx, 'location_error', true);
    }
  }

  async function cancel(ctx) {
    const objectId = parsePayload(ctx.callbackQuery?.data, 'plan_location_cancel');
    if (!objectId) {
      await safeAnswer(ctx, 'location_error', true);
      await replyUserError(ctx, 'BUTTON_EXPIRED');
      return;
    }
    try {
      const user = await db.ensureUser(ctx.from?.id);
      clearLocationRequest(user?.id);
      await safeAnswer(ctx, 'location_manual_skipped');
    } catch (err) {
      console.error('plan_location.cancel error', err);
      await safeAnswer(ctx, 'location_error', true);
    }
  }

  function buildManualKeyboard(objectId) {
    return {
      inline_keyboard: [
        [
          { text: msg('location_geo_button'), callback_data: `plan_location_geo|${objectId}` },
          { text: msg('location_address_button'), callback_data: `plan_location_address|${objectId}` },
        ],
        [{ text: msg('location_cancel_button'), callback_data: `plan_location_cancel|${objectId}` }],
      ],
    };
  }

  return { confirm, change, requestGeo, requestAddress, cancel };
}

function validateOwnership(object, userId) {
  if (!object || !userId) return false;
  return String(object.user_id) === String(userId);
}

async function safeAnswer(ctx, key, alert = false) {
  if (typeof ctx.answerCbQuery === 'function') {
    try {
      await ctx.answerCbQuery(msg(key), { show_alert: alert });
      return;
    } catch {
      // ignore
    }
  }
  if (typeof ctx.reply === 'function') {
    await ctx.reply(msg(key));
  }
}

module.exports = { createPlanLocationHandler };
