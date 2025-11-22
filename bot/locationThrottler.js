const MAX_PROMPTS = Number(process.env.LOCATION_PROMPT_MAX || '2');
const WINDOW_MS = Number(process.env.LOCATION_PROMPT_WINDOW_MS || `${6 * 60 * 60 * 1000}`); // 6h

const store = new Map();

function now() {
  return Date.now();
}

function remember(userId) {
  if (!userId) return { allowed: false, remaining: 0 };
  const entry = store.get(userId) || { count: 0, startedAt: now() };
  if (now() - entry.startedAt > WINDOW_MS) {
    store.set(userId, { count: 1, startedAt: now() });
    return { allowed: true, remaining: Math.max(0, MAX_PROMPTS - 1) };
  }
  if (entry.count >= MAX_PROMPTS) {
    return { allowed: false, remaining: 0 };
  }
  const next = { count: entry.count + 1, startedAt: entry.startedAt };
  store.set(userId, next);
  return { allowed: true, remaining: Math.max(0, MAX_PROMPTS - next.count) };
}

function reset() {
  store.clear();
}

module.exports = { remember, reset };
