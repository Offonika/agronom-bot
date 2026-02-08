'use strict';

require('dotenv').config();
const { Worker } = require('bullmq');
const { Pool } = require('pg');

const { createDb } = require('../services/db');
const { createWeatherService } = require('../services/weather');
const { createAutoPlanner } = require('../services/auto_planner');
const strings = require('../locales/ru.json');
const { formatSlotCard, buildSlotKeyboard } = require('../services/slot_card');
const { processAutoplanContext, buildLocationDetails, pickLocationLabel } = require('./autoplan_core');

const connection = { url: process.env.REDIS_URL || 'redis://localhost:6379' };
const queueName = process.env.AUTOPLAN_QUEUE || 'autoplan';
const BOT_TOKEN =
  process.env.BOT_TOKEN_PROD ||
  process.env.BOT_TOKEN_DEV ||
  process.env.BOT_TOKEN;
const DEFAULT_TZ = process.env.AUTOPLAN_TIMEZONE || 'Europe/Moscow';
const DB_URL = process.env.BOT_DATABASE_URL || process.env.DATABASE_URL;
const POLL_INTERVAL_MS = Number(process.env.AUTOPLAN_POLL_MS || '15000');
const LOCATION_WARN_TTL_HOURS = Number(process.env.LOCATION_WARN_TTL_HOURS || '12');
const LOCATION_WARN_TTL_MS = Math.max(1, LOCATION_WARN_TTL_HOURS || 12) * 60 * 60 * 1000;
const PREF_MIN_SLOTS = Number(process.env.AUTOPLAN_PREF_MIN_SLOTS || '3');
const PREF_MAX_SLOTS = Number(process.env.AUTOPLAN_PREF_MAX_SLOTS || '50');

if (!DB_URL) {
  throw new Error('BOT_DATABASE_URL or DATABASE_URL not set for autoplan worker');
}
if (!BOT_TOKEN) {
  throw new Error('BOT_TOKEN_PROD or BOT_TOKEN_DEV not set for autoplan worker');
}

const pool = new Pool({ connectionString: DB_URL });
const db = createDb(pool);
const weatherService = createWeatherService({ provider: process.env.WEATHER_PROVIDER || 'openmeteo' });
const planner = createAutoPlanner({ weatherService, timezone: DEFAULT_TZ });

const worker = new Worker(
  queueName,
  async (job) => {
    if (!job.data?.runId) {
      job.log('Missing runId');
      return;
    }
    await processAutoplan(job.data.runId);
  },
  {
    connection,
    concurrency: Number(process.env.AUTOPLAN_CONCURRENCY || '2'),
  },
);

worker.on('completed', (job) => {
  console.log('autoplan job completed', job.id);
});

worker.on('failed', (job, err) => {
  console.error('autoplan job failed', job.id, err);
});

// Дополнительный поллер на случай, если продюсер не добавил задачу в очередь (например, ассистент создал run напрямую в БД).
if (Number.isFinite(POLL_INTERVAL_MS) && POLL_INTERVAL_MS > 0) {
  setInterval(async () => {
    try {
      const pending = await db.listPendingAutoplanRuns(5);
      for (const row of pending) {
        if (!row?.id) continue;
        await processAutoplan(row.id);
      }
    } catch (err) {
      console.error('autoplan polling failed', err);
    }
  }, POLL_INTERVAL_MS);
}

async function processAutoplan(runId) {
  const context = await db.getAutoplanRunContext(runId);
  if (!context) {
    console.warn('autoplan run not found', runId);
    return;
  }
  const preferences = await loadUserPreferences(context.user?.id);
  await processAutoplanContext(context, {
    planner,
    db,
    strings,
    fallbackLat: process.env.WEATHER_LAT,
    fallbackLon: process.env.WEATHER_LON,
    preferences,
    trackLocation: trackLocationSource,
    maybeNotifyDefaultLocation,
    sendSlotCard,
    notifyNoWindow,
    notifyFailure,
    updateTimeSession,
    logger: console,
  });
}

async function sendSlotCard(context, slotRow) {
  if (!context.user?.tg_id || !slotRow) return;
  const slot = normalizeSlotRow(slotRow);
  const translate = (key, vars) => format(strings[key] || key, vars);
  const text = formatSlotCard({
    slot,
    stageName: context.stage?.title,
    objectName: context.object?.name,
    translate,
  });
  const markup = buildSlotKeyboard(slot.id, translate);
  await sendTelegramMessage(context.user.tg_id, text, { reply_markup: markup });
}

async function notifyNoWindow(context) {
  if (!context.user?.tg_id) return;
  const text = format(strings.plan_autoplan_none, {
    stage: context.stage?.title || 'этап',
  });
  const keyboard = buildManualFallbackKeyboard(context);
  await sendTelegramMessage(context.user.tg_id, text, keyboard ? { reply_markup: keyboard } : {});
}

async function notifyFailure(context) {
  if (!context.user?.tg_id) return;
  const text = strings.plan_autoplan_failed || 'Не удалось автоматически подобрать окно. Попробуйте вручную.';
  await sendTelegramMessage(context.user.tg_id, text);
}

async function notifyDefaultLocation(context, location) {
  if (!context.user?.tg_id) return;
  const details = buildLocationDetails(location, pickLocationLabel(context));
  const text =
    format(strings.plan_autoplan_default_location || 'Использую стандартные координаты{details}. Отправьте /location, чтобы сделать прогноз точнее.', {
      details,
    });
  const keyboard = buildLocationKeyboard(context);
  await sendTelegramMessage(context.user.tg_id, text, keyboard ? { reply_markup: keyboard } : {});
}

async function maybeNotifyDefaultLocation(context, location) {
  if (!context.user?.tg_id || !context?.object?.id) return;
  const warnedAt =
    location?.warned_at instanceof Date && !Number.isNaN(location.warned_at.getTime())
      ? location.warned_at.getTime()
      : null;
  const warnedRecently = location?.warned && warnedAt && Date.now() - warnedAt < LOCATION_WARN_TTL_MS;
  if (warnedRecently) return;
  await notifyDefaultLocation(context, location);
  if (typeof db.updateObjectMeta === 'function') {
    try {
      await db.updateObjectMeta(context.object.id, {
        location_default_warned: true,
        location_default_warned_at: new Date().toISOString(),
      });
    } catch (err) {
      console.error('autoplan default location meta update failed', err);
    }
  }
}

async function trackLocationSource(context, location) {
  if (typeof db.logFunnelEvent !== 'function') return;
  try {
    await db.logFunnelEvent({
      event: 'autoplan_location',
      userId: context.user?.id || context.run?.user_id || null,
      planId: context.plan?.id || null,
      objectId: context.plan?.object_id || context.object?.id || null,
      data: {
        source: location.source || 'unknown',
        lat: location.lat ?? null,
        lon: location.lon ?? null,
        label: location.label || null,
        warned: Boolean(location.warned),
        warned_at: location.warned_at || null,
      },
    });
  } catch (err) {
    console.error('autoplan location metric failed', err);
  }
}

function normalizeSlotRow(row) {
  return {
    id: row.id,
    plan_id: row.plan_id,
    stage_id: row.stage_id,
    stage_option_id: row.stage_option_id,
    start: row.slot_start instanceof Date ? row.slot_start : new Date(row.slot_start),
    end: row.slot_end instanceof Date ? row.slot_end : new Date(row.slot_end),
    reason: Array.isArray(row.reason) ? row.reason : row.reason ? [row.reason] : [],
    score: row.score ?? null,
    status: row.status,
    autoplan_run_id: row.autoplan_run_id,
  };
}

function format(template, vars = {}) {
  if (!template) return '';
  return Object.entries(vars).reduce((acc, [key, value]) => acc.replace(`{${key}}`, value ?? ''), template);
}

function buildLocationKeyboard(context) {
  const objectId = context?.object?.id || context?.plan?.object_id || null;
  if (!objectId) return null;
  return {
    inline_keyboard: [
      [
        { text: strings.location_geo_button || '📍 Геолокация', callback_data: `plan_location_geo|${objectId}` },
        { text: strings.location_address_button || '⌨️ Ввести адрес', callback_data: `plan_location_address|${objectId}` },
      ],
      [{ text: strings.location_cancel_button || '↩️ Пропустить', callback_data: `plan_location_cancel|${objectId}` }],
    ],
  };
}

async function sendTelegramMessage(chatId, text, options = {}) {
  const payload = {
    chat_id: String(chatId),
    text,
    disable_web_page_preview: true,
  };
  if (options.reply_markup) {
    payload.reply_markup = options.reply_markup;
  }
  if (options.parse_mode) {
    payload.parse_mode = options.parse_mode;
  }
  try {
    const resp = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!resp.ok) {
      const payload = await resp.text().catch(() => '');
      console.error('Telegram send failed', resp.status, payload);
    }
  } catch (err) {
    console.error('Telegram send error', err);
  }
}

async function loadUserPreferences(userId) {
  if (!userId || typeof db.listAcceptedSlotsForUser !== 'function') return null;
  const rows = await db.listAcceptedSlotsForUser(userId, PREF_MAX_SLOTS);
  if (!rows?.length || rows.length < PREF_MIN_SLOTS) return null;
  const hourWeights = new Array(24).fill(0);
  for (const row of rows) {
    const date = row.slot_start instanceof Date ? row.slot_start : new Date(row.slot_start);
    const hour = getLocalHour(date);
    if (hour == null) continue;
    hourWeights[hour] += 1;
  }
  const maxCount = Math.max(...hourWeights);
  if (!maxCount) return null;
  return { hourWeights, maxCount, total: rows.length };
}

function getLocalHour(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return null;
  const raw = new Intl.DateTimeFormat('ru-RU', {
    hour: 'numeric',
    hour12: false,
    timeZone: DEFAULT_TZ,
  }).format(date);
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function buildManualFallbackKeyboard(context) {
  const planId = context?.plan?.id;
  const stageId = context?.stage?.id;
  if (!planId || !stageId) return null;
  const optionId = context?.run?.stage_option_id || 0;
  const label = strings.plan_manual_start_button || 'Подобрать время вручную';
  return {
    inline_keyboard: [
      [
        {
          text: label,
          callback_data: `plan_manual_start|${planId}|${stageId}|${optionId}`,
        },
      ],
    ],
  };
}

async function gracefulShutdown() {
  try {
    await worker.close();
  } catch (err) {
    console.error('Worker close failed', err);
  }
  try {
    await pool.end();
  } catch (err) {
    console.error('Pool close failed', err);
  }
  process.exit(0);
}

process.once('SIGINT', gracefulShutdown);
process.once('SIGTERM', gracefulShutdown);

async function updateTimeSession(planId, payload) {
  if (
    !planId ||
    typeof db.getPlanSessionByPlan !== 'function' ||
    typeof db.updatePlanSession !== 'function'
  ) {
    return;
  }
  const session = await db.getPlanSessionByPlan(planId);
  if (!session) return;
  const state = { ...(session.state || {}), ...(payload.state || {}) };
  try {
    await db.updatePlanSession(session.id, {
      currentStep: payload.step,
      state,
      ttlHours: payload.ttlHours || 72,
    });
  } catch (err) {
    console.error('autoplan session update failed', err);
  }
}

module.exports = { processAutoplan };
