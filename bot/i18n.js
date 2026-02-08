const strings = require('../locales/ru.json');

function resolve(path) {
  if (!path) return undefined;
  if (Object.prototype.hasOwnProperty.call(strings, path)) {
    return strings[path];
  }
  const parts = path.split('.');
  let current = strings;
  for (const part of parts) {
    if (current == null || typeof current !== 'object') {
      return undefined;
    }
    current = current[part];
  }
  return current;
}

function formatText(template, vars = {}) {
  if (typeof template !== 'string') return '';
  return template.replace(/\{([^}]+)\}/g, (match, key) => {
    if (Object.prototype.hasOwnProperty.call(vars, key)) {
      const value = vars[key];
      return value === undefined || value === null ? '' : String(value);
    }
    return match;
  });
}

function t(key, vars = {}) {
  const value = resolve(key);
  if (typeof value === 'string') {
    return formatText(value, vars);
  }
  return value ?? '';
}

function list(key) {
  const value = resolve(key);
  if (Array.isArray(value)) {
    return value;
  }
  return [];
}

function dict(key) {
  const value = resolve(key);
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value;
  }
  return {};
}

function diseaseNameRu(code) {
  if (!code) return '';
  const normalized = String(code).trim().toLowerCase();
  if (!normalized) return '';
  const map =
    dict('diagnosis.disease_map') ||
    dict('diagnosis.diseases') ||
    dict('diseases');
  if (!map || typeof map !== 'object') return '';
  const direct = map[normalized];
  if (direct) return direct;
  // some keys may use spaces/underscores interchangeably
  const cleaned = normalized.replace(/[_-]+/g, ' ');
  return map[cleaned] || '';
}

module.exports = {
  t,
  list,
  dict,
  diseaseNameRu,
  formatText,
  resolve,
  strings,
};
