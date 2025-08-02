const { msg } = require('./utils');
const { logEvent } = require('./payments');

const API_BASE = process.env.API_BASE_URL || 'http://localhost:8000';
const API_KEY = process.env.API_KEY || 'test-api-key';
const API_VER = process.env.API_VER || 'v1';

async function historyHandler(ctx, offset = 0, pool) {
  if (ctx.from && pool) {
    if (offset === 0) {
      logEvent(pool, ctx.from.id, 'history_open');
    }
    logEvent(pool, ctx.from.id, `history_page_${offset}`);
  }
  const resp = await fetch(
    `${API_BASE}/v1/photos/history?limit=10&offset=${offset}`,
    {
      headers: {
        'X-API-Key': API_KEY,
        'X-API-Ver': API_VER,
        'X-User-ID': ctx.from?.id,
      },
    },
  );
  if (!resp.ok) {
    await ctx.reply(msg('history_error'));
    return;
  }
  const data = await resp.json();
  if (!Array.isArray(data)) {
    console.error('Unexpected history response', data);
    await ctx.reply(msg('history_error'));
    return;
  }
  let text = data
    .map((it, idx) => {
      const dt = new Date(it.ts);
      const date = dt.toLocaleDateString('ru-RU');
      return `${idx + offset + 1}. ${date}, ${it.crop}, ${it.disease}, ${it.status}`;
    })
    .join('\n');
  if (!text) text = msg('history_empty');
  const keyboard = data.map((it) => [{ text: 'ℹ️', callback_data: `info|${it.photo_id}` }]);
  keyboard.push([
    { text: '◀️', callback_data: `history|${Math.max(offset - 10, 0)}` },
    { text: '▶️', callback_data: `history|${offset + 10}` },
  ]);
  await ctx.reply(text, { reply_markup: { inline_keyboard: keyboard } });
}

module.exports = { historyHandler };
