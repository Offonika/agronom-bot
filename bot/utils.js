const { t } = require('./i18n');

function msg(key, vars = {}) {
  const value = t(key, vars);
  if (typeof value === 'string') {
    return value;
  }
  return '';
}

module.exports = { msg };
