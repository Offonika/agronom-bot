const crypto = require('node:crypto');
const { msg } = require('./utils');
const { sendPaywall } = require('./payments');

const API_BASE = process.env.API_BASE_URL || 'http://localhost:8000';
const API_KEY = process.env.API_KEY || 'test-api-key';
const API_VER = process.env.API_VER || 'v1';

function formatDiagnosis(ctx, data) {
  let text =
    `Культура: ${data.crop}\n` +
    `Диагноз: ${data.disease}\n` +
    `Уверенность модели: ${(data.confidence * 100).toFixed(1)}%`;
  if (data.protocol_status) {
    text += `\n${data.protocol_status}`;
  }

  let keyboard;
  if (data.protocol) {
    const cb = [
      'proto',
      data.protocol.product,
      data.protocol.dosage_value,
      data.protocol.dosage_unit,
      data.protocol.phi,
    ].join('|');
    const row = [{ text: 'Показать протокол', callback_data: cb }];
    if (data.protocol.id) {
      const urlBase = process.env.PARTNER_LINK_BASE ||
        'https://agrostore.example/agronom';
      const uid = crypto.createHash('sha256')
        .update(String(ctx.from.id))
        .digest('hex');
      const link = `${urlBase}?pid=${data.protocol.id}&src=bot&uid=${uid}&dis=5&utm_campaign=agrobot`;
      row.push({ text: 'Купить препарат', url: link });
    }
    keyboard = { inline_keyboard: [row] };
  } else if (process.env.BETA_EXPERT_CHAT === 'true') {
    keyboard = {
      inline_keyboard: [[{ text: 'Спросить эксперта', callback_data: 'ask_expert' }]],
    };
  }

  return { text, keyboard };
}

async function photoHandler(pool, ctx) {
  const photo = ctx.message.photo[ctx.message.photo.length - 1];
  const { file_id, file_unique_id, width, height, file_size } = photo;
  const userId = ctx.from.id;
  try {
    await pool.query(
      `INSERT INTO photos (user_id, file_id, file_unique_id, width, height, file_size, status)` +
      ` VALUES ($1, $2, $3, $4, $5, $6, 'pending')`,
      [userId, file_id, file_unique_id, width, height, file_size]
    );
  } catch (err) {
    console.error('DB insert error', err);
  }

  try {
    const link = await ctx.telegram.getFileLink(file_id);
    console.log('Downloading photo from', link.href);
    const res = await fetch(link.href);
    const buffer = Buffer.from(await res.arrayBuffer());
    const form = new FormData();
    form.append('image', new Blob([buffer], { type: 'image/jpeg' }), 'photo.jpg');

    console.log('Sending to API', API_BASE + '/v1/ai/diagnose');
    const apiResp = await fetch(API_BASE + '/v1/ai/diagnose', {
      method: 'POST',
      headers: { 'X-API-Key': API_KEY, 'X-API-Ver': API_VER },
      body: form,
    });
    if (apiResp.status === 402) {
      await sendPaywall(ctx, pool);
      return;
    }
    const data = await apiResp.json();
    console.log('API response', data);

    if (data.status === 'pending') {
      await ctx.reply(msg('diag_pending'), {
        reply_markup: {
          inline_keyboard: [[{ text: msg('retry_button'), callback_data: `retry|${data.id}` }]],
        },
      });
      return;
    }

    const { text, keyboard } = formatDiagnosis(ctx, data);
    await ctx.reply(text, { reply_markup: keyboard });
  } catch (err) {
    console.error('diagnose error', err);
    if (typeof ctx.reply === 'function') {
      await ctx.reply(msg('diagnose_error'));
    }
  }
}

function messageHandler(ctx) {
  if (!ctx.message.photo) {
    console.log('Ignoring non-photo message');
  }
}

async function retryHandler(ctx, photoId) {
  try {
    const resp = await fetch(`${API_BASE}/v1/photos/${photoId}`, {
      headers: { 'X-API-Key': API_KEY, 'X-API-Ver': API_VER },
    });
    if (!resp.ok) {
      await ctx.reply(msg('status_error'));
      return;
    }
    const data = await resp.json();
    if (data.status === 'pending' || data.status === 'retrying') {
      await ctx.reply(msg('diag_pending'), {
        reply_markup: {
          inline_keyboard: [[{ text: msg('retry_button'), callback_data: `retry|${photoId}` }]],
        },
      });
      return;
    }

    const { text, keyboard } = formatDiagnosis(ctx, data);
    await ctx.reply(text, { reply_markup: keyboard });
  } catch (err) {
    console.error('retry error', err);
    await ctx.reply(msg('status_error'));
  }
}

module.exports = {
  formatDiagnosis,
  photoHandler,
  messageHandler,
  retryHandler,
};
