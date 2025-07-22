const API_BASE = process.env.API_BASE_URL || 'http://localhost:8000';
const API_KEY = process.env.API_KEY || 'test-api-key';
const API_VER = process.env.API_VER || 'v1';

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
    const data = await apiResp.json();
    console.log('API response', data);

    let text = `Культура: ${data.crop}\nБолезнь: ${data.disease}\nУверенность: ${(data.confidence * 100).toFixed(1)}%`;
    if (data.protocol) {
      text += `\nПрепарат: ${data.protocol.product}\nДоза: ${data.protocol.dosage_value} ${data.protocol.dosage_unit}\nPHI: ${data.protocol.phi}`;
      await ctx.reply(text);
    } else {
      text += `\nБета`;
      const keyboard = { inline_keyboard: [[{ text: 'Спросить эксперта', callback_data: 'ask_expert' }]] };
      await ctx.reply(text, { reply_markup: keyboard });
    }
  } catch (err) {
    console.error('diagnose error', err);
    if (typeof ctx.reply === 'function') {
      await ctx.reply('Ошибка диагностики');
    }
  }
}

function messageHandler(ctx) {
  if (!ctx.message.photo) {
    console.log('Ignoring non-photo message');
  }
}

function startHandler(ctx) {
  ctx.reply('Отправьте фото листа для диагностики');
}

module.exports = { photoHandler, messageHandler, startHandler };
