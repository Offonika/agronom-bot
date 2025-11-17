'use strict';

const { msg } = require('../utils');
const { replyUserError } = require('../userErrors');
const { logFunnelEvent } = require('../funnel');
const {
  HOURS,
  buildTreatmentEvents,
  buildReminderPayloads,
} = require('../../services/plan_events');
const { formatSlotCard, buildSlotKeyboard } = require('../../services/slot_card');

const DEFAULT_SEASON_DELAY_H = Number(process.env.REMINDER_DEFAULT_DELAY_H || '24');
const DEFAULT_ADHOC_DELAY_H = Number(process.env.REMINDER_ADHOC_DELAY_H || '4');
const DEFAULT_AUTOPLAN_MIN_H = Number(process.env.AUTOPLAN_MIN_HOURS_AHEAD || '2');
const DEFAULT_AUTOPLAN_HORIZON_H = Number(process.env.AUTOPLAN_HORIZON_H || '72');
const DEFAULT_SLOT_DURATION_H = Number(process.env.AUTOPLAN_SLOT_DURATION_H || '1');

function hoursToMs(hours) {
  const value = Number.isFinite(hours) ? hours : 0;
  return Math.max(value, 0) * HOURS;
}

function parsePayload(data) {
  if (!data?.startsWith('pick_opt|')) return null;
  const [, plan, stage, option] = data.split('|');
  const planId = Number(plan);
  const stageId = Number(stage);
  const optionId = Number(option);
  if (!planId || !stageId || !optionId) return null;
  return { planId, stageId, optionId };
}

function computeDueAt(stage) {
  const now = Date.now();
  if (!stage || !stage.kind) return new Date(now + hoursToMs(DEFAULT_SEASON_DELAY_H));
  switch (stage.kind) {
    case 'adhoc':
      return new Date(now + hoursToMs(DEFAULT_ADHOC_DELAY_H));
    case 'season':
      return new Date(now + hoursToMs(DEFAULT_SEASON_DELAY_H));
    case 'trigger':
      return null;
    default:
      return new Date(now + hoursToMs(DEFAULT_SEASON_DELAY_H));
  }
}

function createPlanPickHandler({ db, reminderScheduler, autoplanQueue, manualSlots }) {
  if (!db) throw new Error('plan_pick handler requires db');

  return async function handlePlanPick(ctx) {
    const parsed = parsePayload(ctx.callbackQuery?.data);
    if (!parsed) {
      await ctx.answerCbQuery(msg('plan_selection_error'), { show_alert: true });
      await replyUserError(ctx, 'BUTTON_EXPIRED');
      return;
    }
    try {
      const user = await db.ensureUser(ctx.from?.id);
      const result = await db.selectStageOption({
        userId: user.id,
        planId: parsed.planId,
        stageId: parsed.stageId,
        optionId: parsed.optionId,
      });
      const stage = result.stage || {};
      await logFunnelEvent(db, {
        event: 'option_picked',
        userId: user.id,
        planId: parsed.planId,
        objectId: stage.object_id || null,
        data: {
          stageId: parsed.stageId,
          optionId: parsed.optionId,
        },
      });
      const session =
        typeof db.getPlanSessionByPlan === 'function'
          ? await db.getPlanSessionByPlan(parsed.planId)
          : null;
      const allowAutoplan = normalizeStageKind(stage.kind) !== 'trigger';
      if (!allowAutoplan) {
        await updatePlanStatusSafe(db, {
          planId: parsed.planId,
          userId: user.id,
          status: 'accepted',
        });
        await updateSessionState(db, session, parsed.planId, {
          step: 'time_wait_trigger',
          state: {
            planId: parsed.planId,
            stageId: parsed.stageId,
            stageOptionId: parsed.optionId,
          },
        });
        await ctx.answerCbQuery(msg('plan_saved_wait_trigger'), { show_alert: false });
        return;
      }

      const autoplanResult = await maybeScheduleAutoplan({
        autoplanQueue,
        db,
        user,
        stage,
        optionId: parsed.optionId,
      });
      if (autoplanResult?.runId) {
        await updatePlanStatusSafe(db, {
          planId: parsed.planId,
          userId: user.id,
          status: 'accepted',
        });
        await updateSessionState(db, session, parsed.planId, {
          step: 'time_autoplan_lookup',
          state: {
            planId: parsed.planId,
            stageId: parsed.stageId,
            stageOptionId: parsed.optionId,
            autoplanRunId: autoplanResult.runId,
          },
        });
        await ctx.answerCbQuery(msg('plan_autoplan_lookup'), { show_alert: false });
        return;
      }

      const manualHandled = await maybePromptManual(manualSlots, ctx, { stage, optionId: parsed.optionId });
      if (manualHandled) {
        await updatePlanStatusSafe(db, {
          planId: parsed.planId,
          userId: user.id,
          status: 'accepted',
        });
        await updateSessionState(db, session, parsed.planId, {
          step: 'time_manual_prompt',
          state: {
            planId: parsed.planId,
            stageId: parsed.stageId,
            stageOptionId: parsed.optionId,
          },
        });
        await ctx.answerCbQuery(msg('plan_manual_prompt_toast'), { show_alert: false });
        return;
      }

      await sendFallbackSlotCard({
        ctx,
        db,
        user,
        stage,
        optionId: parsed.optionId,
        planId: parsed.planId,
        session,
      });
    } catch (err) {
      console.error('plan_pick error', {
        message: err?.message,
        planId: parsed?.planId ?? null,
        stageId: parsed?.stageId ?? null,
        optionId: parsed?.optionId ?? null,
      });
      await ctx.answerCbQuery(msg('plan_selection_error'), { show_alert: true });
      await replyUserError(ctx, 'BUTTON_EXPIRED');
    }
  };
}

async function sendFallbackSlotCard({ ctx, db, user, stage, optionId, planId, session }) {
  const dueAt = computeDueAt(stage);
  if (!dueAt) {
    await ctx.answerCbQuery(msg('plan_slot_error'), { show_alert: true });
    return;
  }
  const slotEnd = new Date(dueAt.getTime() + hoursToMs(DEFAULT_SLOT_DURATION_H));
  const reasons = [msg('plan_slot_reason_default')];
  let slotRow = null;
  if (typeof db.upsertTreatmentSlot === 'function') {
    slotRow = await db.upsertTreatmentSlot({
      autoplan_run_id: null,
      plan_id: planId,
      stage_id: stage.id,
      stage_option_id: optionId,
      slot_start: dueAt,
      slot_end: slotEnd,
      score: null,
      reason: reasons,
      status: 'proposed',
    });
  }
  const slotId = slotRow?.id || null;
  await updatePlanStatusSafe(db, {
    planId,
    userId: user.id,
    status: 'accepted',
  });
  await updateSessionState(db, session, planId, {
    step: 'time_autoplan_slot',
    state: {
      planId,
      stageId: stage.id,
      stageOptionId: optionId,
      slotId,
    },
  });
  await ctx.answerCbQuery(msg('plan_autoplan_ready'), { show_alert: false });
  const object = stage.object_id && typeof db.getObjectById === 'function'
    ? await db.getObjectById(stage.object_id)
    : null;
  const translate = (key, vars) => msg(key, vars);
  const slot = {
    start: ensureDate(slotRow?.slot_start) || dueAt,
    end: ensureDate(slotRow?.slot_end) || slotEnd,
    reason: Array.isArray(slotRow?.reason) ? slotRow.reason : reasons,
  };
  const text = formatSlotCard({
    slot,
    stageName: stage.title,
    objectName: object?.name,
    translate,
  });
  const keyboard = buildSlotKeyboard(slotId || 0, translate);
  await ctx.reply(text, { reply_markup: keyboard });
}

async function maybeScheduleAutoplan({ autoplanQueue, db, user, stage, optionId }) {
  if (!autoplanQueue || !user?.id || !stage?.id) return null;
  try {
    const run = await db.createAutoplanRun({
      user_id: user.id,
      plan_id: stage.plan_id,
      stage_id: stage.id,
      stage_option_id: optionId || null,
      min_hours_ahead: DEFAULT_AUTOPLAN_MIN_H,
      horizon_hours: DEFAULT_AUTOPLAN_HORIZON_H,
    });
    await autoplanQueue.add(
      'run',
      { runId: run.id },
      {
        removeOnComplete: true,
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
      },
    );
    return { runId: run.id };
  } catch (err) {
    console.error('autoplan enqueue failed', err);
    return null;
  }
}

async function maybePromptManual(manualSlots, ctx, { stage, optionId }) {
  if (!manualSlots?.prompt || !stage) return false;
  try {
    const sent = await manualSlots.prompt(ctx, { stage, optionId });
    return Boolean(sent);
  } catch (err) {
    console.error('plan_pick manual prompt failed', err);
    return false;
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

async function updateSessionState(db, session, planId, payload) {
  if (!db?.updatePlanSession) return;
  const target =
    session ||
    (typeof db.getPlanSessionByPlan === 'function' ? await db.getPlanSessionByPlan(planId) : null);
  if (!target) return;
  const nextState = { ...(target.state || {}), ...(payload.state || {}) };
  try {
    await db.updatePlanSession(target.id, {
      currentStep: payload.step,
      state: nextState,
      ttlHours: payload.ttlHours || 72,
    });
  } catch (err) {
    console.error('plan_pick session update failed', err);
  }
}

function normalizeStageKind(kind) {
  if (!kind) return '';
  return String(kind).trim().toLowerCase();
}

function ensureDate(value) {
  if (!value) return null;
  if (value instanceof Date) return value;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

module.exports = { createPlanPickHandler };
