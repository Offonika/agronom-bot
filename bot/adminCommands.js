'use strict';

const { logBetaEventOnce } = require('./beta');

function parseIdList(raw) {
  if (!raw) return [];
  const text = String(raw).trim();
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) {
      return parsed.map((v) => Number(v)).filter((v) => Number.isFinite(v));
    }
  } catch {
    // fallback to delimited list
  }
  return text
    .split(/[,\s]+/)
    .map((item) => Number(item.trim()))
    .filter((v) => Number.isFinite(v));
}

function uniqueIds(ids) {
  const uniq = new Set();
  for (const id of ids) {
    if (Number.isFinite(id)) uniq.add(Number(id));
  }
  return Array.from(uniq);
}

function getAdminIds() {
  return uniqueIds(parseIdList(process.env.ADMIN_TG_IDS));
}

function isAdmin(tgId) {
  if (!tgId) return false;
  const admins = getAdminIds();
  if (!admins.length) return false;
  return admins.includes(Number(tgId));
}

function getCommandArgs(ctx) {
  const text = ctx?.message?.text || '';
  return text.replace(/^\/\w+(@\w+)?\s*/i, '').trim();
}

function parseTargetIds(ctx) {
  return uniqueIds(parseIdList(getCommandArgs(ctx)));
}

function formatIds(ids) {
  return ids.join(', ');
}

async function handleBetaAdd(ctx, db) {
  const requesterId = ctx?.from?.id;
  if (!isAdmin(requesterId)) {
    await ctx.reply('Недостаточно прав.');
    return;
  }
  if (!db?.ensureUser || !db.updateUserBeta) {
    await ctx.reply('DB не готова.');
    return;
  }
  const ids = parseTargetIds(ctx);
  if (!ids.length) {
    await ctx.reply('Укажите tg_id: /beta_add 123456789');
    return;
  }
  const enabled = [];
  const failed = [];
  for (const tgId of ids) {
    try {
      let user = typeof db.getUserByTgId === 'function' ? await db.getUserByTgId(tgId) : null;
      if (!user) {
        user = await db.ensureUser(tgId);
      }
      if (!user?.id) {
        failed.push(tgId);
        continue;
      }
      if (!user.is_beta) {
        const updated = await db.updateUserBeta(user.id, { isBeta: true });
        if (!updated) {
          failed.push(tgId);
          continue;
        }
      }
      enabled.push(tgId);
      await logBetaEventOnce(db, user.id, 'beta_entered', { source: 'admin' });
    } catch (err) {
      console.error('beta_add failed', err);
      failed.push(tgId);
    }
  }
  const lines = [];
  if (enabled.length) lines.push(`Включено: ${formatIds(enabled)}.`);
  if (failed.length) lines.push(`Не удалось: ${formatIds(failed)}.`);
  if (!lines.length) lines.push('Ничего не изменилось.');
  await ctx.reply(lines.join('\n'));
}

async function handleBetaRemove(ctx, db) {
  const requesterId = ctx?.from?.id;
  if (!isAdmin(requesterId)) {
    await ctx.reply('Недостаточно прав.');
    return;
  }
  if (!db?.getUserByTgId || !db.updateUserBeta) {
    await ctx.reply('DB не готова.');
    return;
  }
  const ids = parseTargetIds(ctx);
  if (!ids.length) {
    await ctx.reply('Укажите tg_id: /beta_remove 123456789');
    return;
  }
  const disabled = [];
  const missing = [];
  for (const tgId of ids) {
    try {
      const user = await db.getUserByTgId(tgId);
      if (!user) {
        missing.push(tgId);
        continue;
      }
      if (user.is_beta) {
        await db.updateUserBeta(user.id, { isBeta: false });
      }
      disabled.push(tgId);
    } catch (err) {
      console.error('beta_remove failed', err);
      missing.push(tgId);
    }
  }
  const lines = [];
  if (disabled.length) lines.push(`Отключено: ${formatIds(disabled)}.`);
  if (missing.length) lines.push(`Не найдены: ${formatIds(missing)}.`);
  if (!lines.length) lines.push('Ничего не изменилось.');
  await ctx.reply(lines.join('\n'));
}

async function handleBetaList(ctx, db) {
  const requesterId = ctx?.from?.id;
  if (!isAdmin(requesterId)) {
    await ctx.reply('Недостаточно прав.');
    return;
  }
  if (!db?.listBetaUsers) {
    await ctx.reply('DB не готова.');
    return;
  }
  const raw = getCommandArgs(ctx);
  const limit = Math.min(Math.max(Number(raw) || 20, 1), 200);
  const rows = await db.listBetaUsers(limit);
  if (!rows.length) {
    await ctx.reply('Бета-пользователей нет.');
    return;
  }
  const lines = rows.map((row, idx) => `${idx + 1}. ${row.tg_id} (id ${row.id})`);
  await ctx.reply(lines.join('\n'));
}

module.exports = {
  handleBetaAdd,
  handleBetaRemove,
  handleBetaList,
};
