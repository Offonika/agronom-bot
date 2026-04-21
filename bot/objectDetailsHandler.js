'use strict';

const { msg, sanitizeObjectName } = require('./utils');
const { setSessionAsync, peekSessionAsync, clearSessionAsync } = require('./objectDetailsSession');

function createObjectDetailsHandler({ db, objectChips = null }) {
  if (!db) throw new Error('objectDetails handler requires db');

  async function getObjectSafe(objectId) {
    if (!objectId || typeof db.getObjectById !== 'function') return null;
    try {
      return await db.getObjectById(objectId);
    } catch (err) {
      console.error('objectDetails getObject failed', err);
      return null;
    }
  }

  async function startPrompt(ctx, { field, objectId }) {
    const userId = ctx.from?.id;
    const normalizedObjectId = Number(objectId);
    if (!userId || !normalizedObjectId || !['variety', 'note', 'rename'].includes(field)) {
      return false;
    }
    const object = await getObjectSafe(normalizedObjectId);
    if (!object || Number(object.user_id) !== Number(userId)) {
      await ctx.reply(msg('objects_not_found'));
      return true;
    }
    const promptKey =
      field === 'variety'
        ? 'object_details_prompt_variety'
        : field === 'note'
          ? 'object_details_prompt_note'
          : 'object_rename_prompt';
    const objectName = sanitizeObjectName(object.name, msg('object.default_name'));
    const sent = await ctx.reply(msg(promptKey, { name: objectName }));
    await setSessionAsync(userId, {
      objectId: object.id,
      field,
      promptMessageId: sent?.message_id || null,
    });
    return true;
  }

  async function handleText(ctx) {
    const userId = ctx.from?.id;
    const text = ctx.message?.text?.trim();
    if (!userId || !text) return false;
    if (text.startsWith('/')) return false;
    const { entry: session, expired } = await peekSessionAsync(userId);
    if (!session) {
      if (expired) {
        await ctx.reply(msg('object_details_expired'));
        return true;
      }
      return false;
    }
    const replyMessageId = Number(ctx.message?.reply_to_message?.message_id);
    if (!replyMessageId || replyMessageId !== Number(session.promptMessageId)) {
      await ctx.reply(msg('object_details_reply_required'));
      return true;
    }
    const object = await getObjectSafe(session.objectId);
    if (!object || Number(object.user_id) !== Number(userId)) {
      await clearSessionAsync(userId);
      await ctx.reply(msg('objects_not_found'));
      return true;
    }
    if (session.field === 'rename') {
      const cleaned = text.trim();
      const sanitizedName = sanitizeObjectName(cleaned, '');
      if (!sanitizedName || sanitizedName.length < 2 || sanitizedName.length > 64) {
        await ctx.reply(msg('object_rename_invalid'));
        return true;
      }
      if (typeof db.updateObjectName === 'function') {
        await db.updateObjectName(object.user_id, object.id, sanitizedName);
      }
      await clearSessionAsync(userId);
      await ctx.reply(msg('object_rename_saved', { name: sanitizedName }));
      if (objectChips) {
        await objectChips.send(ctx);
      }
      return true;
    }
    const patch =
      session.field === 'variety'
        ? { variety: text, details_prompted_at: new Date().toISOString() }
        : session.field === 'note'
          ? { note: text, details_prompted_at: new Date().toISOString() }
          : null;
    if (patch && typeof db.updateObjectMeta === 'function') {
      await db.updateObjectMeta(object.id, patch);
    }
    await clearSessionAsync(userId);
    const key = session.field === 'variety' ? 'object_details_saved_variety' : 'object_details_saved_note';
    await ctx.reply(msg(key, { value: text }));
    if (objectChips) {
      await objectChips.send(ctx);
    }
    return true;
  }

  return {
    startPrompt,
    handleText,
  };
}

module.exports = { createObjectDetailsHandler };
