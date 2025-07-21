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
  if (typeof ctx.reply === 'function') {
    await ctx.reply('Фото получено');
  }
}

function messageHandler(ctx) {
  if (!ctx.message.photo) {
    console.log('Ignoring non-photo message');
  }
}

module.exports = { photoHandler, messageHandler };
