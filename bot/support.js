const { msg } = require('./utils');

const SUPPORT_SESSION_TTL_MS = Number(process.env.SUPPORT_SESSION_TTL_MS || 15 * 60 * 1000);
const pendingSupport = new Map();

function getSupportChatId() {
  const raw = (process.env.SUPPORT_CHAT_ID || '').trim();
  return raw || null;
}

function isExpired(entry) {
  if (!entry) return true;
  return Date.now() - entry.startedAt > SUPPORT_SESSION_TTL_MS;
}

function buildSupportPayload(ctx, text) {
  const from = ctx.from || {};
  const name = [from.first_name, from.last_name].filter(Boolean).join(' ') || '—';
  const username = from.username ? `@${from.username}` : '—';
  const chatId = ctx.chat?.id != null ? String(ctx.chat.id) : '—';
  const locale = from.language_code || '—';
  const timestamp = new Date().toISOString();
  const header = msg('support_forward_header', {
    name,
    username,
    user_id: from.id || '—',
    chat_id: chatId,
    locale,
    timestamp,
  });
  const body = msg('support_forward_body', { text });
  return [header, body].filter(Boolean).join('\n\n');
}

async function start(ctx) {
  const supportChatId = getSupportChatId();
  if (!supportChatId) {
    await ctx.reply(msg('support_unavailable'));
    return false;
  }
  const userId = ctx.from?.id;
  if (!userId) return false;
  pendingSupport.set(userId, { startedAt: Date.now() });
  await ctx.reply(msg('support_prompt'), {
    reply_markup: {
      inline_keyboard: [[{ text: msg('support_cancel_button'), callback_data: 'support_cancel' }]],
    },
  });
  return true;
}

async function cancel(ctx) {
  const userId = ctx.from?.id;
  if (userId) {
    pendingSupport.delete(userId);
  }
  await ctx.reply(msg('support_cancelled'));
}

async function handleSupportText(ctx) {
  const userId = ctx.from?.id;
  const text = ctx.message?.text?.trim();
  if (!userId || !text) return false;
  const pending = pendingSupport.get(userId);
  if (!pending) return false;
  if (text.startsWith('/')) return false;
  if (isExpired(pending)) {
    pendingSupport.delete(userId);
    await ctx.reply(msg('support_expired'));
    return true;
  }
  const supportChatId = getSupportChatId();
  if (!supportChatId) {
    pendingSupport.delete(userId);
    await ctx.reply(msg('support_unavailable'));
    return true;
  }
  try {
    await ctx.telegram.sendMessage(supportChatId, buildSupportPayload(ctx, text));
  } catch (err) {
    console.error('support.send_failed', err);
    await ctx.reply(msg('support_send_failed'));
    return true;
  }
  pendingSupport.delete(userId);
  await ctx.reply(msg('support_sent'));
  return true;
}

module.exports = {
  start,
  cancel,
  handleSupportText,
};
