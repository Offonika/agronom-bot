'use strict';

const { msg } = require('../utils');

const HOURS = 60 * 60 * 1000;
const DEFAULT_SEASON_DELAY_H = Number(process.env.REMINDER_DEFAULT_DELAY_H || '24');
const DEFAULT_ADHOC_DELAY_H = Number(process.env.REMINDER_ADHOC_DELAY_H || '4');

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

function buildEventPayloads(userId, stage, dueAt) {
  if (!dueAt) return [];
  const events = [
    {
      user_id: userId,
      plan_id: stage.plan_id,
      stage_id: stage.id,
      type: 'treatment',
      due_at: dueAt,
      status: 'scheduled',
    },
  ];
  if (stage.phi_days) {
    const phiAt = new Date(dueAt.getTime() + Number(stage.phi_days) * 24 * HOURS);
    events.push({
      user_id: userId,
      plan_id: stage.plan_id,
      stage_id: stage.id,
      type: 'phi',
      due_at: phiAt,
      status: 'scheduled',
    });
  }
  return events;
}

function buildReminderPayloads(events) {
  return events
    .filter((event) => event.due_at)
    .map((event) => ({
      user_id: event.user_id,
      event_id: event.id,
      fire_at: event.due_at,
      payload: {
        type: event.type,
        stage_id: event.stage_id,
        plan_id: event.plan_id,
      },
    }));
}

function createPlanPickHandler({ db }) {
  if (!db) throw new Error('plan_pick handler requires db');

  return async function handlePlanPick(ctx) {
    const parsed = parsePayload(ctx.callbackQuery?.data);
    if (!parsed) {
      await ctx.answerCbQuery(msg('plan_selection_error'), { show_alert: true });
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
      const dueAt = computeDueAt(result.stage);
      const eventsToCreate = buildEventPayloads(user.id, result.stage, dueAt);
      let reminderMsg = 'plan_saved_wait_trigger';
      if (eventsToCreate.length) {
        const createdEvents = await db.createEvents(eventsToCreate);
        const reminders = buildReminderPayloads(createdEvents);
        if (reminders.length) {
          await db.createReminders(reminders);
        }
        reminderMsg = 'plan_saved_toast';
      }
      await ctx.answerCbQuery(msg(reminderMsg), { show_alert: false });
    } catch (err) {
      console.error('plan_pick error', err);
      await ctx.answerCbQuery(msg('plan_selection_error'), { show_alert: true });
    }
  };
}

module.exports = { createPlanPickHandler };
