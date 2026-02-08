const { t } = require('./i18n');

function msg(key, vars = {}) {
  const value = t(key, vars);
  if (typeof value === 'string') {
    return value;
  }
  return '';
}

function sanitizeObjectName(value, fallback = '') {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return fallback;
  const collapsed = raw.replace(/\s+/g, ' ');
  const stripped = collapsed.replace(/[.•·…]+/g, '').trim();
  if (!stripped) return fallback;
  return collapsed;
}

function botLink(ctx, suffix = '') {
  const fromCtx = ctx?.botInfo?.username;
  const fromEnv = process.env.BOT_USERNAME || process.env.TELEGRAM_BOT_USERNAME;
  const username = (fromCtx || fromEnv || '').replace(/^@/, '');
  if (!username) return null;
  return `https://t.me/${username}${suffix}`;
}

module.exports = { msg, botLink, sanitizeObjectName };
