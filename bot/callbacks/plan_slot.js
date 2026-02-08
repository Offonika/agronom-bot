'use strict';

const { msg } = require('../utils');
const { replyUserError } = require('../userErrors');
const { logFunnelEvent } = require('../funnel');
const { buildTreatmentEvents, buildReminderPayloads } = require('../../services/plan_events');
const { limitRemindersForUser } = require('../reminderLimits');

const SLOT_TZ = process.env.AUTOPLAN_TIMEZONE || 'Europe/Moscow';
const DEFAULT_AUTOPLAN_MIN_H = Number(process.env.AUTOPLAN_MIN_HOURS_AHEAD || '2');
const DEFAULT_AUTOPLAN_HORIZON_H = Number(process.env.AUTOPLAN_HORIZON_H || '72');

function createPlanSlotHandlers({ db, reminderScheduler, autoplanQueue }) {
  if (!db) throw new Error('planSlot handlers require db');

  async function accept(ctx) {
    const slotId = parseSlotPayload(ctx.callbackQuery?.data, 'plan_slot_accept');
    if (!slotId) return handleInvalid(ctx);
    try {
      const context = await loadSlot(ctx, slotId);
      if (!context) return handleInvalid(ctx);
      if (!isSlotPending(context.slot)) return handleInvalid(ctx);
      const dueAt = toDate(context.slot.slot_start);
      const slotEnd = toDate(context.slot.slot_end);
      const events = await db.createEvents(
        buildTreatmentEvents({
          userId: context.user.id,
          stage: context.stage,
          dueAt,
          slotEnd,
          source: context.slot.autoplan_run_id ? 'autoplan' : 'manual',
          reason: formatReasonText(context.slot.reason),
          stageOptionId: context.slot.stage_option_id,
          autoplanRunId: context.slot.autoplan_run_id,
        }),
      );
      const reminders = buildReminderPayloads(events);
      if (reminders.length) {
        const { allowed, limited } = await limitRemindersForUser(db, context.user.id, reminders);
        if (allowed.length) {
          const createdReminders = await db.createReminders(allowed);
          if (reminderScheduler) {
            reminderScheduler.scheduleMany(createdReminders);
          }
        }
        if (limited) {
          await ctx.reply(msg('reminder_limit_reached'));
        }
      }
      await db.updateTreatmentSlot(context.slot.id, { status: 'accepted' });
      if (context.slot.autoplan_run_id) {
        await db.updateAutoplanRun(context.slot.autoplan_run_id, { status: 'accepted' });
      }
      await db.updatePlanStatus({
        planId: context.plan.id,
        userId: context.user.id,
        status: 'scheduled',
      });
      await safeAnswer(ctx, 'plan_slot_confirmed_toast');
      await ctx.reply(
        msg('plan_slot_confirmed', {
          date: formatHumanDate(dueAt),
          time: formatHumanTime(dueAt),
        }),
      );
      await logFunnelEvent(db, {
        event: 'slot_confirmed',
        userId: context.user.id,
        planId: context.plan?.id || null,
        objectId: context.plan?.object_id || null,
        data: {
          mode: 'autoplan',
          slotId: context.slot.id,
        },
      });
      await clearTimeSession(db, context.plan?.id);
    } catch (err) {
      console.error('plan_slot.accept error', err);
      await safeAnswer(ctx, 'plan_slot_error', true);
      await replyUserError(ctx, 'BUTTON_EXPIRED');
    }
  }

  async function cancel(ctx) {
    const slotId = parseSlotPayload(ctx.callbackQuery?.data, 'plan_slot_cancel');
    if (!slotId) return handleInvalid(ctx);
    try {
      const context = await loadSlot(ctx, slotId);
      if (!context) return handleInvalid(ctx);
      if (!isSlotPending(context.slot)) return handleInvalid(ctx);
      await db.updateTreatmentSlot(context.slot.id, { status: 'cancelled' });
      if (context.slot.autoplan_run_id) {
        await db.updateAutoplanRun(context.slot.autoplan_run_id, { status: 'cancelled' });
      }
      await safeAnswer(ctx, 'plan_slot_cancelled_toast');
      await ctx.reply(msg('plan_slot_cancelled'));
      await clearTimeSession(db, context.plan?.id);
    } catch (err) {
      console.error('plan_slot.cancel error', err);
      await safeAnswer(ctx, 'plan_slot_error', true);
      await replyUserError(ctx, 'BUTTON_EXPIRED');
    }
  }

  async function reschedule(ctx) {
    const slotId = parseSlotPayload(ctx.callbackQuery?.data, 'plan_slot_reschedule');
    if (!slotId) return handleInvalid(ctx);
    try {
      const context = await loadSlot(ctx, slotId);
      if (!context) return handleInvalid(ctx);
      if (!isSlotPending(context.slot)) return handleInvalid(ctx);
      if (!autoplanQueue) {
        console.warn('plan_slot.reschedule queue_missing');
        return handleInvalid(ctx);
      }
      await db.updateTreatmentSlot(context.slot.id, { status: 'rejected' });
      if (context.slot.autoplan_run_id) {
        await db.updateAutoplanRun(context.slot.autoplan_run_id, { status: 'rejected' });
      }
      const baseRun = context.autoplanRun || {};
      const newRun = await db.createAutoplanRun({
        user_id: context.user.id,
        plan_id: context.plan.id,
        stage_id: context.stage.id,
        stage_option_id: context.slot.stage_option_id,
        min_hours_ahead:
          Number.isFinite(baseRun.min_hours_ahead) && baseRun.min_hours_ahead > 0
            ? baseRun.min_hours_ahead
            : DEFAULT_AUTOPLAN_MIN_H,
        horizon_hours:
          Number.isFinite(baseRun.horizon_hours) && baseRun.horizon_hours > 0
            ? baseRun.horizon_hours
            : DEFAULT_AUTOPLAN_HORIZON_H,
      });
      await autoplanQueue.add(
        'run',
        { runId: newRun.id },
        {
          removeOnComplete: true,
          attempts: 3,
          backoff: { type: 'exponential', delay: 5000 },
        },
      );
      await safeAnswer(ctx, 'plan_slot_retry_toast');
      await ctx.reply(msg('plan_slot_retry'));
    } catch (err) {
      console.error('plan_slot.reschedule error', err);
      await safeAnswer(ctx, 'plan_slot_error', true);
      await replyUserError(ctx, 'BUTTON_EXPIRED');
    }
  }

  async function handleInvalid(ctx) {
    await safeAnswer(ctx, 'plan_slot_not_found', true);
    await replyUserError(ctx, 'PLAN_NOT_FOUND');
  }

  async function loadSlot(ctx, slotId) {
    const tgId = ctx.from?.id;
    if (!tgId) return null;
    const context = await db.getTreatmentSlotContext(slotId);
    if (!context) return null;
    if (String(context.user?.tg_id) !== String(tgId)) return null;
    return context;
  }

  return { accept, cancel, reschedule };
}

function parseSlotPayload(data, prefix) {
  if (!data?.startsWith(prefix)) return null;
  const [, id] = data.split('|');
  const slotId = Number(id);
  return Number.isFinite(slotId) ? slotId : null;
}

function isSlotPending(slot) {
  if (!slot) return false;
  return slot.status === 'proposed';
}

function toDate(value) {
  if (!value) return null;
  if (value instanceof Date) return value;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function formatReasonText(items) {
  if (!items?.length) return null;
  return items.join('; ');
}

function formatHumanDate(date) {
  if (!date) return '';
  return new Intl.DateTimeFormat('ru-RU', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: SLOT_TZ,
  }).format(date);
}

function formatHumanTime(date) {
  if (!date) return '';
  return new Intl.DateTimeFormat('ru-RU', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: SLOT_TZ,
  }).format(date);
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

async function updateTimeSession(db, planId, payload) {
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
    console.error('plan_slot session update failed', err);
  }
}

async function clearTimeSession(db, planId) {
  if (!db?.deletePlanSessionsByPlan || !planId) return;
  try {
    await db.deletePlanSessionsByPlan(planId);
  } catch (err) {
    console.error('plan_slot session clear failed', err);
  }
}

module.exports = { createPlanSlotHandlers };
