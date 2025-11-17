'use strict';

require('dotenv').config();
const { Worker } = require('bullmq');
const { Pool } = require('pg');

const { createDb } = require('../services/db');
const { createWeatherService } = require('../services/weather');
const { createAutoPlanner } = require('../services/auto_planner');
const strings = require('../locales/ru.json');
const { formatSlotCard, buildSlotKeyboard } = require('../services/slot_card');
const { resolveObjectLocation } = require('./location_utils');

const connection = { url: process.env.REDIS_URL || 'redis://localhost:6379' };
const queueName = process.env.AUTOPLAN_QUEUE || 'autoplan';
const BOT_TOKEN = process.env.BOT_TOKEN_DEV;
const DEFAULT_TZ = process.env.AUTOPLAN_TIMEZONE || 'Europe/Moscow';
const DB_URL = process.env.BOT_DATABASE_URL || process.env.DATABASE_URL;

if (!DB_URL) {
  throw new Error('BOT_DATABASE_URL or DATABASE_URL not set for autoplan worker');
}
if (!BOT_TOKEN) {
  throw new Error('BOT_TOKEN_DEV not set for autoplan worker');
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

async function processAutoplan(runId) {
  const context = await db.getAutoplanRunContext(runId);
  if (!context) {
    console.warn('autoplan run not found', runId);
    return;
  }
  const location = resolveLocation(context);
  await trackLocationSource(context, location);
  console.info('autoplan.location', {
    runId,
    planId: context.plan?.id || null,
    objectId: context.plan?.object_id || context.object?.id || null,
    source: location.source || 'unknown',
  });
  const stageRules = (context.stage?.meta && context.stage.meta.weather) || {};
  try {
    await db.updateAutoplanRun(runId, {
      status: 'in_progress',
      started_at: new Date(),
    });
    if (location.source === 'default') {
      await maybeNotifyDefaultLocation(context, location);
    }
    const slot = await planner.findWindow({
      latitude: location.lat,
      longitude: location.lon,
      minHoursAhead: context.run.min_hours_ahead,
      horizonHours: context.run.horizon_hours,
      rules: stageRules,
    });
    if (!slot) {
      await db.updateAutoplanRun(runId, {
        status: 'awaiting_window',
        reason: 'no_window',
        finished_at: new Date(),
      });
      await notifyNoWindow(context);
      return;
    }
    const savedSlot = await db.upsertTreatmentSlot({
      autoplan_run_id: runId,
      plan_id: context.plan.id,
      stage_id: context.stage.id,
      stage_option_id: context.run.stage_option_id,
      slot_start: slot.start,
      slot_end: slot.end,
      score: slot.score,
      reason: slot.reason,
      status: 'proposed',
    });
    await db.updateAutoplanRun(runId, {
      status: 'awaiting_confirmation',
      reason: slot.reason.join('; '),
      finished_at: new Date(),
    });
    await updateTimeSession(context.plan.id, {
      step: 'time_autoplan_slot',
      state: {
        planId: context.plan.id,
        stageId: context.stage.id,
        stageOptionId: context.run.stage_option_id || null,
        slotId: savedSlot.id,
      },
    });
    await sendSlotCard(context, savedSlot);
  } catch (err) {
    console.error('autoplan run failed', runId, err);
    await db.updateAutoplanRun(runId, {
      status: 'failed',
      error: err.message,
      finished_at: new Date(),
    });
    await notifyFailure(context);
    throw err;
  }
}

function resolveLocation(context) {
  const meta = (context.object && context.object.meta) || {};
  return resolveObjectLocation(meta, process.env.WEATHER_LAT, process.env.WEATHER_LON);
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

async function notifyDefaultLocation(context) {
  if (!context.user?.tg_id) return;
  const text = strings.plan_autoplan_default_location || 'Использую стандартные координаты. Отправьте /location, чтобы сделать прогноз точнее.';
  await sendTelegramMessage(context.user.tg_id, text);
}

async function maybeNotifyDefaultLocation(context, location) {
  if (!context.user?.tg_id || !context?.object?.id || location.warned) return;
  await notifyDefaultLocation(context);
  if (typeof db.updateObjectMeta === 'function') {
    try {
      await db.updateObjectMeta(context.object.id, { location_default_warned: true });
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
