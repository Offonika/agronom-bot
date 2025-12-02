'use strict';

const { msg } = require('./utils');

const MAX_CHIPS = Number(process.env.OBJECT_CHIPS_LIMIT || '6');
const ROW_SIZE = 3;
const PLAN_SELECTION_STEPS = new Set(['choose_object', 'confirm_object']);

function chunk(items, size) {
  const rows = [];
  for (let i = 0; i < items.length; i += size) {
    rows.push(items.slice(i, i + size));
  }
  return rows;
}

function isSessionExpired(session) {
  if (!session?.expires_at) return false;
  const expiresAt = new Date(session.expires_at);
  if (Number.isNaN(expiresAt.getTime())) return false;
  return expiresAt.getTime() < Date.now();
}

function isPlanSelectionStep(step) {
  if (!step) return false;
  return PLAN_SELECTION_STEPS.has(String(step));
}

function createObjectChips({ bot, db, planFlow }) {
  if (!bot || !db) throw new Error('objectChips requires bot and db');

  async function fetchObjects(userId) {
    const user = await db.ensureUser(userId);
    const objects = await db.listObjects(user.id);
    const activeId = user.last_object_id || objects[0]?.id;
    return { objects, activeId };
  }

  function formatLabel(obj) {
    const parts = [];
    if (obj?.meta?.variety) parts.push(obj.meta.variety);
    if (obj?.meta?.note) parts.push(obj.meta.note);
    if (!parts.length) return obj.name;
    return `${obj.name} • ${parts.join(' / ')}`;
  }

  function buildKeyboard(objects, activeId) {
    if (!objects.length) return null;
    const chips = objects.slice(0, MAX_CHIPS).map((obj) => {
      const label = formatLabel(obj);
      return {
        text: obj.id === activeId ? `• ${label}` : label,
        callback_data: `obj_switch|${obj.id}`,
      };
    });
    const rows = chunk(chips, ROW_SIZE);
    return { inline_keyboard: rows };
  }

  async function send(ctx) {
    try {
      const userId = ctx.from?.id;
      const chatId = ctx.chat?.id;
      if (!userId || !chatId) return;
      const { objects, activeId } = await fetchObjects(userId);
      if (!objects.length) {
        console.info('objectChips.send.skip_empty', { userId });
        return;
      }
      const keyboard = buildKeyboard(objects, activeId);
      if (!keyboard) {
        console.info('objectChips.send.skip_keyboard', { userId, objects: objects.length });
        return;
      }
      console.info('objectChips.send', {
        userId,
        chatId,
        objects: objects.length,
        activeId,
      });
      await bot.telegram.sendMessage(chatId, msg('object_chip_prompt'), {
        reply_markup: keyboard,
      });
    } catch (err) {
      console.error('objectChips send error', err);
    }
  }

  async function handleSwitch(ctx, objectId) {
    const userId = ctx.from?.id;
    const key = objectId != null ? String(objectId) : null;
    if (!userId || !key) {
      console.warn('objectChips.switch.no_context', { userId, objectId: key });
      await answer(ctx, msg('objects_error'), true);
      return;
    }
    try {
      console.info('objectChips.switch.click', { userId, objectId: key });
      const user = await db.ensureUser(userId);
      const objects = await db.listObjects(user.id);
      const target = objects.find((obj) => String(obj.id) === key);
      if (!target) {
        console.warn('objectChips.switch.missing', {
          userId,
          objectId: key,
          objects: objects.length,
        });
        await answer(ctx, msg('objects_not_found'), true);
        return;
      }
      const alreadyActive = String(user.last_object_id) === key;
      await db.updateUserLastObject(user.id, target.id);
      const keyboard = buildKeyboard(objects, target.id);
      if (!alreadyActive && keyboard && typeof ctx.editMessageReplyMarkup === 'function') {
        try {
          await ctx.editMessageReplyMarkup(keyboard);
        } catch (err) {
          if (!String(err?.description || '').includes('message is not modified')) {
            throw err;
          }
        }
      }
      if (planFlow && typeof db.getLatestPlanSessionForUser === 'function') {
        const session = await db.getLatestPlanSessionForUser(user.id);
        const shouldForward =
          session && !isSessionExpired(session) && isPlanSelectionStep(session.current_step);
        if (shouldForward) {
          console.info('objectChips.switch.forward_plan_flow', {
            userId,
            objectId: key,
            sessionId: session.id,
          });
          await planFlow.pick(ctx, target.id, session.token || null);
          return;
        }
      }
      if (alreadyActive) {
        console.info('objectChips.switch.already_active', { userId, objectId: key });
      }
      if (typeof ctx.answerCbQuery === 'function') {
        await ctx.answerCbQuery(msg('objects_switched_chip', { name: target.name }));
      }
      if (!alreadyActive) {
        console.info('objectChips.switch.applied', {
          userId,
          objectId: target.id,
          objectName: target.name,
        });
      }
    } catch (err) {
      console.error('objectChips switch error', err);
      await answer(ctx, msg('objects_error'), true);
    }
  }

  async function answer(ctx, text, alert = false) {
    if (typeof ctx.answerCbQuery === 'function') {
      await ctx.answerCbQuery(text, { show_alert: alert });
    } else if (typeof ctx.reply === 'function') {
      await ctx.reply(text);
    }
  }

  return { send, handleSwitch };
}

module.exports = { createObjectChips };
