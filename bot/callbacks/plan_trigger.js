'use strict';

const { msg } = require('../utils');
const { replyUserError } = require('../userErrors');
const {
  HOURS,
  buildTreatmentEvents,
  buildReminderPayloads,
} = require('../../services/plan_events');
const { limitRemindersForUser } = require('../reminderLimits');
const DEFAULT_TRIGGER_DELAY_H = Number(process.env.TRIGGER_DELAY_H || process.env.REMINDER_DEFAULT_DELAY_H || '24');
const TRIGGER_CHOICES = [
  { key: 'now', hoursAgo: 0, textKey: 'plan_trigger_option_now' },
  { key: 'today', hoursAgo: 6, textKey: 'plan_trigger_option_today' },
  { key: 'yesterday', hoursAgo: 24, textKey: 'plan_trigger_option_yesterday' },
];

function hoursToMs(hours) {
  const value = Number.isFinite(hours) ? hours : 0;
  return Math.max(value, 0) * HOURS;
}

function parsePayload(data, prefix) {
  if (!data?.startsWith(prefix)) return null;
  const [, plan, stage, extra] = data.split('|');
  const planId = Number(plan);
  const stageId = Number(stage);
  if (!planId || !stageId) return null;
  return { planId, stageId, extra };
}

function normalizeKey(value) {
  if (value === undefined || value === null) return null;
  return String(value);
}

function createPlanTriggerHandler({ db, reminderScheduler }) {
  if (!db) throw new Error('planTrigger handler requires db');

  async function prompt(ctx) {
    const parsed = parsePayload(ctx.callbackQuery?.data, 'plan_trigger');
    if (!parsed) {
      await safeAnswer(ctx, 'plan_trigger_error', true);
      await replyUserError(ctx, 'BUTTON_EXPIRED');
      return;
    }
    try {
      const user = await db.ensureUser(ctx.from?.id);
      const stage = await db.getStageById(parsed.stageId);
      if (!validateStage(stage, parsed.planId, user.id)) {
        console.warn('plan_trigger.validate_failed', {
          userId: user.id,
          planId: parsed.planId,
          stageId: parsed.stageId,
          stageFound: Boolean(stage),
          stageOwner: stage?.user_id ?? null,
          stageKind: stage?.kind ?? null,
          stagePlanId: stage?.plan_id ?? null,
        });
        await safeAnswer(ctx, 'plan_trigger_error', true);
        await replyUserError(ctx, 'PLAN_NOT_FOUND');
        return;
      }
      await ctx.answerCbQuery();
      await ctx.reply(msg('plan_trigger_prompt', { stage: stage.title || msg('reminder_stage_fallback') }), {
        reply_markup: {
          inline_keyboard: TRIGGER_CHOICES.map((choice) => [
            {
              text: msg(choice.textKey),
              callback_data: `plan_trigger_at|${parsed.planId}|${parsed.stageId}|${choice.hoursAgo}`,
            },
          ]),
        },
      });
    } catch (err) {
      console.error('plan_trigger prompt error', err);
      await safeAnswer(ctx, 'plan_trigger_error', true);
      await replyUserError(ctx, 'BUTTON_EXPIRED');
    }
  }

  async function confirm(ctx) {
    const parsed = parsePayload(ctx.callbackQuery?.data, 'plan_trigger_at');
    if (!parsed) {
      await safeAnswer(ctx, 'plan_trigger_error', true);
      await replyUserError(ctx, 'BUTTON_EXPIRED');
      return;
    }
    const hoursAgo = Number(parsed.extra || '0');
    try {
      const user = await db.ensureUser(ctx.from?.id);
      const stage = await db.getStageById(parsed.stageId);
      if (!validateStage(stage, parsed.planId, user.id)) {
        console.warn('plan_trigger.validate_failed', {
          userId: user.id,
          planId: parsed.planId,
          stageId: parsed.stageId,
          stageFound: Boolean(stage),
          stageOwner: stage?.user_id ?? null,
          stageKind: stage?.kind ?? null,
          stagePlanId: stage?.plan_id ?? null,
        });
        await safeAnswer(ctx, 'plan_trigger_error', true);
        await replyUserError(ctx, 'PLAN_NOT_FOUND');
        return;
      }
      const dueAt = computeDueDate(hoursAgo);
      const events = await db.createEvents(
        buildTreatmentEvents({
          userId: user.id,
          stage,
          dueAt,
        }),
      );
      const reminders = buildReminderPayloads(events);
      if (reminders.length) {
        const { allowed, limited } = await limitRemindersForUser(db, user.id, reminders);
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
      await updatePlanStatusSafe(db, {
        planId: parsed.planId,
        userId: user.id,
        status: 'scheduled',
      });
      console.log('plan_trigger_scheduled', {
        userId: user.id,
        planId: parsed.planId,
        stageId: parsed.stageId,
        dueAt,
      });
      await safeAnswer(ctx, 'plan_trigger_scheduled');
    } catch (err) {
      console.error('plan_trigger confirm error', err);
      await safeAnswer(ctx, 'plan_trigger_error', true);
      await replyUserError(ctx, 'BUTTON_EXPIRED');
    }
  }

  function validateStage(stage, planId, userId) {
    if (!stage) return false;
    const stagePlanKey = normalizeKey(stage.plan_id);
    const requestedPlanKey = normalizeKey(planId);
    if (!stagePlanKey || !requestedPlanKey || stagePlanKey !== requestedPlanKey) {
      return false;
    }
    const stageOwnerKey = normalizeKey(stage.user_id);
    const requesterKey = normalizeKey(userId);
    if (!stageOwnerKey || !requesterKey || stageOwnerKey !== requesterKey) {
      return false;
    }
    if ((stage.kind || '').toLowerCase() !== 'trigger') return false;
    return true;
  }

  function computeDueDate(hoursAgo) {
    const triggerMoment = new Date(Date.now() - hoursAgo * HOURS);
    const tentative = new Date(triggerMoment.getTime() + hoursToMs(DEFAULT_TRIGGER_DELAY_H));
    if (tentative < new Date()) return new Date();
    return tentative;
  }

  return { prompt, confirm };
}

async function safeAnswer(ctx, key, alert = false) {
  if (typeof ctx.answerCbQuery === 'function') {
    try {
      await ctx.answerCbQuery(msg(key), { show_alert: alert });
      return;
    } catch {
      // ignore
    }
  }
  if (typeof ctx.reply === 'function') {
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

module.exports = { createPlanTriggerHandler };
