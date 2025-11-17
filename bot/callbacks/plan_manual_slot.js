'use strict';

const { msg } = require('../utils');
const { replyUserError } = require('../userErrors');
const { logFunnelEvent } = require('../funnel');
const { buildTreatmentEvents, buildReminderPayloads } = require('../../services/plan_events');

const TIMEZONE = process.env.AUTOPLAN_TIMEZONE || 'Europe/Moscow';
const MIN_LEAD_MINUTES = Number(process.env.MANUAL_SLOT_MIN_LEAD_MIN || '120');
const MIN_LEAD_MS = Math.max(1, MIN_LEAD_MINUTES) * 60 * 1000;
const QUICK_PRESETS = [
  { labelKey: 'plan_manual_today_evening', daysAhead: 0, hour: 18, minute: 0 },
  { labelKey: 'plan_manual_tomorrow_morning', daysAhead: 1, hour: 9, minute: 0 },
];
const PICKER_PRESETS = [
  { daysAhead: 0, hour: 9, minute: 0 },
  { daysAhead: 0, hour: 18, minute: 0 },
  { daysAhead: 1, hour: 9, minute: 0 },
  { daysAhead: 1, hour: 18, minute: 0 },
  { daysAhead: 2, hour: 9, minute: 0 },
  { daysAhead: 2, hour: 18, minute: 0 },
];
const MAX_PICKER_OPTIONS = 6;

function createPlanManualSlotHandlers({ db, reminderScheduler }) {
  if (!db) throw new Error('manual slot handlers require db');

  async function prompt(ctx, { stage, optionId }) {
    if (!ctx?.reply || !stage?.plan_id || !stage?.id) return false;
    const quickButtons = buildQuickButtons(stage.plan_id, stage.id, optionId);
    if (!quickButtons.length) {
      await ctx.reply(msg('plan_manual_option_no_slots'));
      return false;
    }
    const text = msg('plan_manual_prompt', {
      stage: stage.title || msg('reminder_stage_fallback'),
    });
    const keyboard = quickButtons.map((button) => [button]);
    keyboard.push([
      {
        text: msg('plan_manual_pick_date'),
        callback_data: buildPickData(stage.plan_id, stage.id, optionId),
      },
    ]);
    await ctx.reply(text, { reply_markup: { inline_keyboard: keyboard } });
    return true;
  }

  async function start(ctx) {
    const parsed = parseStartPayload(ctx.callbackQuery?.data);
    if (!parsed) {
      await invalid(ctx);
      return;
    }
    try {
      const user = await db.ensureUser(ctx.from?.id);
      if (!user) {
        await invalid(ctx);
        return;
      }
      const stage = await db.getStageById(parsed.stageId);
      if (!stage || stage.plan_id !== parsed.planId || stage.user_id !== user.id) {
        await invalid(ctx);
        return;
      }
      const handled = await prompt(ctx, { stage, optionId: parsed.optionId });
      if (!handled) {
        await invalid(ctx);
        return;
      }
      await updateTimeSessionState(db, stage.plan_id, {
        step: 'time_manual_prompt',
        state: {
          planId: stage.plan_id,
          stageId: stage.id,
          stageOptionId: parsed.optionId || null,
        },
      });
      await safeAnswer(ctx, 'plan_manual_prompt_toast');
    } catch (err) {
      console.error('plan_manual.start error', err);
      await invalid(ctx);
    }
  }

  async function pick(ctx) {
    const parsed = parsePickPayload(ctx.callbackQuery?.data);
    if (!parsed) {
      await invalid(ctx);
      return;
    }
    try {
      const user = await db.ensureUser(ctx.from?.id);
      if (!user) {
        await invalid(ctx);
        return;
      }
      const stage = await db.getStageById(parsed.stageId);
      if (!stage || stage.plan_id !== parsed.planId || stage.user_id !== user.id) {
        await invalid(ctx);
        return;
      }
      const options = buildPickerButtons(stage.plan_id, stage.id, parsed.optionId);
      if (!options.length) {
        await safeAnswer(ctx, 'plan_manual_option_no_slots', true);
        return;
      }
      const rows = chunk(options, 2);
      await ctx.reply(msg('plan_manual_picker_prompt'), {
        reply_markup: { inline_keyboard: rows },
      });
      await ctx.answerCbQuery();
    } catch (err) {
      console.error('plan_manual.pick error', err);
      await invalid(ctx);
    }
  }

  async function confirm(ctx) {
    const parsed = parseSlotPayload(ctx.callbackQuery?.data);
    if (!parsed) {
      await invalid(ctx);
      return;
    }
    try {
      const user = await db.ensureUser(ctx.from?.id);
      if (!user) {
        await invalid(ctx);
        return;
      }
      const stage = await db.getStageById(parsed.stageId);
      if (!stage || stage.plan_id !== parsed.planId || stage.user_id !== user.id) {
        await invalid(ctx);
        return;
      }
      const dueAt = new Date(parsed.timestamp);
      if (Number.isNaN(dueAt.getTime()) || dueAt.getTime() <= Date.now()) {
        await safeAnswer(ctx, 'plan_manual_expired', true);
        await prompt(ctx, { stage, optionId: parsed.optionId });
        return;
      }
      const events = await db.createEvents(
        buildTreatmentEvents({
          userId: user.id,
          stage,
          dueAt,
          stageOptionId: parsed.optionId || null,
        }),
      );
      const reminders = buildReminderPayloads(events);
      if (reminders.length) {
        const createdReminders = await db.createReminders(reminders);
        if (reminderScheduler) {
          reminderScheduler.scheduleMany(createdReminders);
        }
      }
      await updatePlanStatusSafe(db, {
        planId: parsed.planId,
        userId: user.id,
        status: 'scheduled',
      });
      await updateTimeSessionState(db, parsed.planId, {
        step: 'time_scheduled',
        state: {
          planId: parsed.planId,
          stageId: stage.id,
          stageOptionId: parsed.optionId || null,
          manualTimestamp: dueAt.toISOString(),
        },
      });
      await clearTimeSession(db, parsed.planId);
      await safeAnswer(ctx, 'plan_slot_confirmed_toast');
      await ctx.reply(
        msg('plan_slot_confirmed', {
          date: formatHumanDate(dueAt),
          time: formatHumanTime(dueAt),
        }),
      );
      await logFunnelEvent(db, {
        event: 'slot_confirmed',
        userId: user.id,
        planId: parsed.planId,
        objectId: stage.object_id || null,
        data: {
          mode: 'manual',
          optionId: parsed.optionId || null,
        },
      });
    } catch (err) {
      console.error('plan_manual.confirm error', err);
      await invalid(ctx);
    }
  }

  async function invalid(ctx) {
    await safeAnswer(ctx, 'plan_slot_not_found', true);
    await replyUserError(ctx, 'PLAN_NOT_FOUND');
  }

  return { prompt, pick, confirm, start };
}

function buildQuickButtons(planId, stageId, optionId) {
  const buttons = [];
  for (const preset of QUICK_PRESETS) {
    const dueAt = computePresetDate(preset);
    if (!dueAt) continue;
    buttons.push({
      text: `${msg(preset.labelKey)} · ${formatShortDate(dueAt)}`,
      callback_data: buildSlotData(planId, stageId, optionId, dueAt),
    });
  }
  return buttons;
}

function buildPickerButtons(planId, stageId, optionId) {
  const now = Date.now();
  const buttons = [];
  for (const preset of PICKER_PRESETS) {
    if (buttons.length >= MAX_PICKER_OPTIONS) break;
    const dueAt = createZonedDate(preset);
    if (!dueAt) continue;
    if (dueAt.getTime() < now + MIN_LEAD_MS) continue;
    buttons.push({
      text: formatPickerLabel(dueAt),
      callback_data: buildSlotData(planId, stageId, optionId, dueAt),
    });
  }
  return buttons;
}

function buildSlotData(planId, stageId, optionId, dueAt) {
  return `plan_manual_slot|${planId}|${stageId}|${optionId || 0}|ts:${dueAt.getTime()}`;
}

function buildPickData(planId, stageId, optionId) {
  return `plan_manual_pick|${planId}|${stageId}|${optionId || 0}`;
}

function computePresetDate(preset) {
  let offset = preset.daysAhead || 0;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const candidate = createZonedDate({ daysAhead: offset, hour: preset.hour, minute: preset.minute });
    if (candidate && candidate.getTime() >= Date.now() + MIN_LEAD_MS) {
      return candidate;
    }
    offset += 1;
  }
  return createZonedDate({ daysAhead: offset, hour: preset.hour, minute: preset.minute });
}

function createZonedDate({ daysAhead = 0, hour = 0, minute = 0 }) {
  const base = new Date(Date.now() + daysAhead * 24 * 60 * 60 * 1000);
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const [year, month, day] = formatter
    .format(base)
    .split('-')
    .map((value) => Number(value));
  return zonedTimeToUtc({ year, month, day, hour, minute });
}

function zonedTimeToUtc({ year, month, day, hour, minute }) {
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return null;
  const utcDate = new Date(Date.UTC(year, month - 1, day, hour || 0, minute || 0, 0, 0));
  const invDate = new Date(utcDate.toLocaleString('en-US', { timeZone: TIMEZONE }));
  const diff = utcDate.getTime() - invDate.getTime();
  return new Date(utcDate.getTime() + diff);
}

function parseStartPayload(data) {
  if (!data?.startsWith('plan_manual_start|')) return null;
  const [, plan, stage, option] = data.split('|');
  const planId = Number(plan);
  const stageId = Number(stage);
  const optionId = Number(option) || null;
  if (!planId || !stageId) return null;
  return { planId, stageId, optionId };
}

function parseSlotPayload(data) {
  if (!data?.startsWith('plan_manual_slot|')) return null;
  const [, plan, stage, option, payload] = data.split('|');
  const planId = Number(plan);
  const stageId = Number(stage);
  const optionId = Number(option) || null;
  if (!planId || !stageId || !payload?.startsWith('ts:')) return null;
  const timestamp = Number(payload.slice(3));
  if (!Number.isFinite(timestamp)) return null;
  return { planId, stageId, optionId, timestamp };
}

function parsePickPayload(data) {
  if (!data?.startsWith('plan_manual_pick|')) return null;
  const [, plan, stage, option] = data.split('|');
  const planId = Number(plan);
  const stageId = Number(stage);
  const optionId = Number(option) || null;
  if (!planId || !stageId) return null;
  return { planId, stageId, optionId };
}

function formatShortDate(date) {
  const datePart = new Intl.DateTimeFormat('ru-RU', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: TIMEZONE,
  }).format(date);
  const timePart = new Intl.DateTimeFormat('ru-RU', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: TIMEZONE,
  }).format(date);
  return `${datePart}, ${timePart}`;
}

function formatPickerLabel(date) {
  const datePart = new Intl.DateTimeFormat('ru-RU', {
    weekday: 'short',
    day: '2-digit',
    month: 'long',
    timeZone: TIMEZONE,
  }).format(date);
  const timePart = new Intl.DateTimeFormat('ru-RU', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: TIMEZONE,
  }).format(date);
  return `${datePart} · ${timePart}`;
}

function formatHumanDate(date) {
  return new Intl.DateTimeFormat('ru-RU', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: TIMEZONE,
  }).format(date);
}

function formatHumanTime(date) {
  return new Intl.DateTimeFormat('ru-RU', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: TIMEZONE,
  }).format(date);
}

function chunk(items, size) {
  const rows = [];
  for (let i = 0; i < items.length; i += size) {
    rows.push(items.slice(i, i + size));
  }
  return rows;
}

async function safeAnswer(ctx, key, alert = false) {
  if (typeof ctx?.answerCbQuery === 'function') {
    try {
      await ctx.answerCbQuery(msg(key), { show_alert: alert });
      return;
    } catch {
      // ignore
    }
  }
  if (typeof ctx?.reply === 'function') {
    await ctx.reply(msg(key));
  }
}

async function updatePlanStatusSafe(db, payload) {
  if (!db?.updatePlanStatus) return;
  try {
    await db.updatePlanStatus(payload);
  } catch (err) {
    console.error('plan status update failed', err);
  }
}

async function updateTimeSessionState(db, planId, payload) {
  if (!db?.getPlanSessionByPlan || !db?.updatePlanSession || !planId) return;
  const session = await db.getPlanSessionByPlan(planId);
  if (!session) return;
  const nextState = { ...(session.state || {}), ...(payload.state || {}) };
  try {
    await db.updatePlanSession(session.id, {
      currentStep: payload.step,
      state: nextState,
      ttlHours: payload.ttlHours || 72,
    });
  } catch (err) {
    console.error('plan_manual session update failed', err);
  }
}

async function clearTimeSession(db, planId) {
  if (!db?.deletePlanSessionsByPlan || !planId) return;
  try {
    await db.deletePlanSessionsByPlan(planId);
  } catch (err) {
    console.error('plan_manual session clear failed', err);
  }
}

module.exports = { createPlanManualSlotHandlers };
