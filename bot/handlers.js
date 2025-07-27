const API_BASE = process.env.API_BASE_URL || 'http://localhost:8000';
const API_KEY = process.env.API_KEY || 'test-api-key';
const API_VER = process.env.API_VER || 'v1';
const crypto = require('node:crypto');

async function buyProHandler(ctx, pool, intervalMs = 3000) {
  ctx.answerCbQuery();
  if (ctx.from) {
    logEvent(pool, ctx.from.id, 'paywall_click_buy');
  }
  try {
    const resp = await fetch(`${API_BASE}/v1/payments/create`, {
      method: 'POST',
      headers: { 'X-API-Key': API_KEY, 'X-API-Ver': API_VER },
    });
    const data = await resp.json();
    ctx.paymentId = data.payment_id;
    const reply = ctx.reply('Оплатите подписку', {
      reply_markup: {
        inline_keyboard: [[{ text: 'Оплатить 199 ₽ через СБП', url: data.url }]],
      },
    });
    if (intervalMs > 0) {
      ctx.pollPromise = pollPaymentStatus(ctx, data.payment_id, intervalMs).catch(
        (e) => console.error('poll error', e)
      );
    }
    return reply;
  } catch (err) {
    console.error('payment error', err);
    return ctx.reply('Ошибка создания платежа');
  }
}
function paywallEnabled() {
  return process.env.PAYWALL_ENABLED !== 'false';
}

function getLimit() {
  return parseInt(process.env.FREE_PHOTO_LIMIT || '5', 10);
}

/**
 * Send paywall message with subscription links.
 */
async function logEvent(pool, userId, ev) {
  if (!pool) return;
  try {
    await pool.query('INSERT INTO events (user_id, event) VALUES ($1, $2)', [userId, ev]);
  } catch (err) {
    console.error('event log error', err);
  }
}

function sendPaywall(ctx, pool) {
  if (!paywallEnabled()) {
    return;
  }
  if (ctx.from) {
    logEvent(pool, ctx.from.id, 'paywall_shown');
  }
  const limit = getLimit();
  return ctx.reply(`Бесплатный лимит ${limit} фото/мес исчерпан`, {
    reply_markup: {
      inline_keyboard: [
        [
          { text: 'Купить PRO', callback_data: 'buy_pro' },
          { text: 'Подробнее', url: 'https://t.me/YourBot?start=faq' },
        ],
      ],
    },
  });
}

/**
 * Handle incoming photo messages.
 * Downloads the photo, sends it to the API and replies with diagnosis.
 */
async function photoHandler(pool, ctx) {
  const photo = ctx.message.photo[ctx.message.photo.length - 1];
  const { file_id, file_unique_id, width, height, file_size } = photo;
  const userId = ctx.from.id;
  try {
    await pool.query(
      `INSERT INTO photos (user_id, file_id, file_unique_id, width, height, file_size, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'pending')`,
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
      await ctx.reply('Диагноз в процессе обработки. Результат появится позже.', {
        reply_markup: {
          inline_keyboard: [[{ text: '🔄 Проверить позже', callback_data: `retry|${data.id}` }]],
        },
      });
      return;
    }

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
    } else {
      keyboard = {
        inline_keyboard: [[{ text: 'Задать вопрос эксперту', callback_data: 'ask_expert' }]],
      };
    }

    await ctx.reply(text, { reply_markup: keyboard });
  } catch (err) {
    console.error('diagnose error', err);
    if (typeof ctx.reply === 'function') {
      await ctx.reply('Ошибка диагностики');
    }
  }
}

/**
 * Ignore non-photo messages in chat.
 */
function messageHandler(ctx) {
  if (!ctx.message.photo) {
    console.log('Ignoring non-photo message');
  }
}

/**
 * Send onboarding message when user starts the bot.
 */
function startHandler(ctx, pool) {
  if (ctx.startPayload === 'paywall') {
    logEvent(pool, ctx.from.id, 'paywall_click_buy');
  } else if (ctx.startPayload === 'faq') {
    logEvent(pool, ctx.from.id, 'paywall_click_faq');
  }
  ctx.reply('Отправьте фото листа для диагностики');
}

/**
 * Temporary stub for subscription command.
 */
function subscribeHandler(ctx, pool) {
  return sendPaywall(ctx, pool);
}

async function retryHandler(ctx, photoId) {
  try {
    const resp = await fetch(`${API_BASE}/v1/photos/${photoId}/status`, {
      headers: { 'X-API-Key': API_KEY, 'X-API-Ver': API_VER },
    });
    if (!resp.ok) {
      await ctx.reply('Ошибка запроса статуса');
      return;
    }
    const data = await resp.json();
    if (data.status === 'pending' || data.status === 'retrying') {
      await ctx.reply('Диагноз в процессе обработки. Результат появится позже.', {
        reply_markup: {
          inline_keyboard: [[{ text: '🔄 Проверить позже', callback_data: `retry|${photoId}` }]],
        },
      });
      return;
    }

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
        const urlBase = process.env.PARTNER_LINK_BASE || 'https://agrostore.example/agronom';
        const uid = crypto.createHash('sha256').update(String(ctx.from.id)).digest('hex');
        const link = `${urlBase}?pid=${data.protocol.id}&src=bot&uid=${uid}&dis=5&utm_campaign=agrobot`;
        row.push({ text: 'Купить препарат', url: link });
      }
      keyboard = { inline_keyboard: [row] };
    } else {
      keyboard = { inline_keyboard: [[{ text: 'Задать вопрос эксперту', callback_data: 'ask_expert' }]] };
    }

    await ctx.reply(text, { reply_markup: keyboard });
  } catch (err) {
    console.error('retry error', err);
    await ctx.reply('Ошибка запроса статуса');
  }
}

async function pollPaymentStatus(ctx, paymentId, intervalMs = 3000) {
  for (let i = 0; i < 20; i += 1) {
    await new Promise((r) => setTimeout(r, intervalMs));
    try {
      const resp = await fetch(`${API_BASE}/v1/payments/${paymentId}`, {
        headers: { 'X-API-Key': API_KEY, 'X-API-Ver': API_VER },
      });
      if (!resp.ok) continue;
      const data = await resp.json();
      if (['success', 'fail', 'cancel'].includes(data.status)) {
        if (data.status === 'success') {
          const dt = new Date(data.pro_expires_at);
          const date = dt.toLocaleDateString('ru-RU');
          await ctx.reply(`Оплата прошла ✅, PRO активен до ${date}`);
        } else {
          await ctx.reply('Оплата не удалась ❌');
        }
        break;
      }
    } catch (e) {
      console.error('status check error', e);
    }
  }
}

module.exports = {
  photoHandler,
  messageHandler,
  startHandler,
  subscribeHandler,
  buyProHandler,
  retryHandler,
  pollPaymentStatus,
};
