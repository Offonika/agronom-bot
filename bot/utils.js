const strings = require('../locales/ru.json');

function msg(key, vars = {}) {
  let text = strings[key] || '';
  for (const [k, v] of Object.entries(vars)) {
    text = text.replace(`{${k}}`, v);
  }
  return text;
}

module.exports = { msg };
