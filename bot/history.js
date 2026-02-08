const { msg } = require('./utils');
const { logEvent } = require('./payments');
const { buildApiHeaders } = require('./apiAuth');
const { createDb } = require('../services/db');

const API_BASE = process.env.API_BASE_URL || 'http://localhost:8010';

async function historyHandler(ctx, cursor = '', pool) {
  if (!ctx.from) {
    await ctx.reply(msg('history_error'));
    return;
  }
  let db = null;
  if (pool?.ensureUser) {
    db = pool;
  } else if (pool) {
    try {
      db = createDb(pool);
    } catch (err) {
      console.error('history createDb failed', err);
    }
  }
  if (pool) {
    if (!cursor) {
      try {
        await logEvent(pool, ctx.from.id, 'history_open');
      } catch (err) {
        console.error('logEvent history_open error', err);
      }
    }
    try {
      await logEvent(pool, ctx.from.id, `history_page_${cursor || '0'}`);
    } catch (err) {
      console.error('logEvent history_page error', err);
    }
  }
  try {
    if (!db?.ensureUser) {
      await ctx.reply(msg('history_error'));
      return;
    }
    const user = await db.ensureUser(ctx.from.id);
    if (!user?.api_key) {
      await ctx.reply(msg('history_error'));
      return;
    }
    const usage = typeof db.getCaseUsage === 'function' ? await db.getCaseUsage(user.id) : null;
    const isPro = Boolean(usage?.isPro || usage?.isBeta);
    if (!isPro) {
      if (typeof db.getLatestRecentDiagnosis !== 'function') {
        await ctx.reply(msg('history_error'));
        return;
      }
      const recent = await db.getLatestRecentDiagnosis(user.id);
      if (!recent) {
        await ctx.reply(msg('history_free_empty') || msg('history_empty'));
        return;
      }
      let payload = recent.diagnosis_payload;
      if (payload && typeof payload === 'string') {
        try {
          payload = JSON.parse(payload);
        } catch (err) {
          payload = null;
        }
      }
      const crop = payload?.crop || '';
      const disease = payload?.disease || '';
      const dt = new Date(recent.created_at || Date.now());
      const date = dt.toLocaleDateString('ru-RU');
      const text = msg('history_free_current', { date, crop, disease }) ||
        `Текущий кейс: ${date}, ${crop}, ${disease}\n\nПолная история доступна в Pro.`;
      await ctx.reply(text, {
        reply_markup: {
          inline_keyboard: [[{ text: msg('paywall_try_pro_button') || '✨ Попробовать Pro', callback_data: 'buy_pro' }]],
        },
      });
      return;
    }
    const url = `${API_BASE}/v1/photos?limit=10${cursor ? `&cursor=${cursor}` : ''}`;
    const headers = buildApiHeaders({
      apiKey: user.api_key,
      userId: user.id,
      method: 'GET',
      path: '/v1/photos',
      query: url.split('?')[1] || '',
    });
    const resp = await fetch(url, { headers });
    if (!resp.ok) {
      await ctx.reply(msg('history_error'));
      return;
    }
    const data = await resp.json();
    if (!data || !Array.isArray(data.items)) {
      console.error('Unexpected history response', data);
      await ctx.reply(msg('history_error'));
      return;
    }
    const items = data.items;
    let text = items
      .map((it, idx) => {
        const dt = new Date(it.ts);
        const date = dt.toLocaleDateString('ru-RU');
        return `${idx + 1}. ${date}, ${it.crop}, ${it.disease}`;
      })
      .join('\n');
    if (!text) text = msg('history_empty');
    const keyboard = items.map((it) => [{ text: 'ℹ️', callback_data: `info|${it.id}` }]);
    if (data.next_cursor) {
      keyboard.push([{ text: '▶️', callback_data: `history|${data.next_cursor}` }]);
    }
    await ctx.reply(text, { reply_markup: { inline_keyboard: keyboard } });
  } catch (err) {
    console.error('history fetch error', err);
    await ctx.reply(msg('history_error'));
  }
}

module.exports = { historyHandler };
