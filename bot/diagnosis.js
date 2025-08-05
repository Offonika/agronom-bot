const crypto = require('node:crypto');
const { msg } = require('./utils');
const { sendPaywall } = require('./payments');

const PRODUCT_NAMES_MAX = 100;
const productNames = new Map();

function cleanupProductNames() {
  if (productNames.size >= PRODUCT_NAMES_MAX) {
    const oldestKey = productNames.keys().next().value;
    if (oldestKey !== undefined) {
      productNames.delete(oldestKey);
    }
  }
}

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
    const encode = (v) => encodeURIComponent(String(v));
    const safeSlice = (str, max) => {
      if (str.length <= max) return str;
      let s = str.slice(0, max);
      const pct = s.lastIndexOf('%');
      if (pct > -1 && pct > s.length - 3) {
        s = s.slice(0, pct);
      }
      return s;
    };
    const product = data.protocol.product || '';
    let productHash = product;
    if (productHash.length > 32) {
      productHash = crypto.createHash('sha256').update(productHash).digest('hex');
    }
    const other = [
      encode(data.protocol.dosage_value),
      encode(data.protocol.dosage_unit),
      encode(data.protocol.phi),
    ];
    const base = ['proto', '', ...other].join('|');
    const avail = 64 - base.length;
    const prodEncoded = safeSlice(encode(productHash), Math.max(avail, 0));
    cleanupProductNames();
    productNames.set(decodeURIComponent(prodEncoded), product);
    const cb = ['proto', prodEncoded, ...other].join('|').slice(0, 64);
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
    if (!res.ok) {
      console.error('Photo download error', res.status);
      if (typeof ctx.reply === 'function') {
        await ctx.reply(msg('diagnose_error'));
      }
      return;
    }
    const buffer = Buffer.from(await res.arrayBuffer());
    const form = new FormData();
    form.append('image', new Blob([buffer], { type: 'image/jpeg' }), 'photo.jpg');

    console.log('Sending to API', API_BASE + '/v1/ai/diagnose');
    const apiResp = await fetch(API_BASE + '/v1/ai/diagnose', {
      method: 'POST',
      headers: {
        'X-API-Key': API_KEY,
        'X-API-Ver': API_VER,
        'X-User-ID': userId,
      },
      body: form,
    });
    if (apiResp.status === 402) {
      await sendPaywall(ctx, pool);
      return;
    }
    if (!apiResp.ok) {
      console.error('API error status', apiResp.status);
      let errCode;
      try {
        const errData = await apiResp.json();
        errCode = errData?.error_code;
      } catch (err) {
        console.error('Failed to parse API error response', err);
      }
      if (typeof ctx.reply === 'function') {
        if (errCode) {
          await ctx.reply(msg('error_' + errCode));
        } else {
          await ctx.reply(msg('diagnose_error'));
        }
      }
      return;
    }
    let data;
    try {
      data = await apiResp.json();
    } catch (err) {
      console.error('Failed to parse API response', err);
      if (typeof ctx.reply === 'function') {
        await ctx.reply(msg('diagnose_error'));
      }
      return;
    }
    console.log('API response', data);

    if (data.status === 'pending') {
      const cb = `retry|${encodeURIComponent(String(data.id))}`.slice(0, 64);
      await ctx.reply(msg('diag_pending'), {
        reply_markup: {
          inline_keyboard: [[{ text: msg('retry_button'), callback_data: cb }]],
        },
      });
      return;
    }

    const { text, keyboard } = formatDiagnosis(ctx, data);
    const opts = keyboard ? { reply_markup: keyboard } : undefined;
    await ctx.reply(text, opts);
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
      headers: {
        'X-API-Key': API_KEY,
        'X-API-Ver': API_VER,
        'X-User-ID': ctx.from?.id,
      },
    });
    if (!resp.ok) {
      await ctx.reply(msg('status_error'));
      return;
    }
    const data = await resp.json();
    if (data.status === 'pending' || data.status === 'retrying') {
      const cb = `retry|${encodeURIComponent(String(photoId))}`.slice(0, 64);
      await ctx.reply(msg('diag_pending'), {
        reply_markup: {
          inline_keyboard: [[{ text: msg('retry_button'), callback_data: cb }]],
        },
      });
      return;
    }

    const { text, keyboard } = formatDiagnosis(ctx, data);
    const opts = keyboard ? { reply_markup: keyboard } : undefined;
    await ctx.reply(text, opts);
  } catch (err) {
    console.error('retry error', err);
    await ctx.reply(msg('status_error'));
  }
}

function getProductName(hash) {
  return productNames.get(hash);
}

module.exports = {
  formatDiagnosis,
  photoHandler,
  messageHandler,
  retryHandler,
  getProductName,
};
