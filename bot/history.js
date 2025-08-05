const { msg } = require('./utils');
const { logEvent } = require('./payments');

const API_BASE = process.env.API_BASE_URL || 'http://localhost:8000';
const API_KEY = process.env.API_KEY || 'test-api-key';
const API_VER = process.env.API_VER || 'v1';

async function historyHandler(ctx, cursor = '', pool) {
  if (!ctx.from) {
    await ctx.reply(msg('history_error'));
    return;
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
    const headers = {
      'X-API-Key': API_KEY,
      'X-API-Ver': API_VER,
    };
    if (ctx.from) headers['X-User-ID'] = ctx.from.id;
    const url = `${API_BASE}/v1/photos?limit=10${cursor ? `&cursor=${cursor}` : ''}`;
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
