'use strict';

const { msg } = require('../utils');

const HOURS = 60 * 60 * 1000;
const DEFAULT_TRIGGER_DELAY_H = Number(process.env.TRIGGER_DELAY_H || process.env.REMINDER_DEFAULT_DELAY_H || '24');

function hoursToMs(hours) {
  const value = Number.isFinite(hours) ? hours : 0;
  return Math.max(value, 0) * HOURS;
}

function parsePayload(data) {
  if (!data?.startsWith('plan_trigger|')) return null;
  const [, plan, stage] = data.split('|');
  const planId = Number(plan);
  const stageId = Number(stage);
  if (!planId || !stageId) return null;
  return { planId, stageId };
}

function createPlanTriggerHandler({ db }) {
  if (!db) throw new Error('planTrigger handler requires db');

  return async function handlePlanTrigger(ctx) {
    const parsed = parsePayload(ctx.callbackQuery?.data);
    if (!parsed) {
      await safeAnswer(ctx, 'plan_trigger_error', true);
      return;
    }
    try {
      const user = await db.ensureUser(ctx.from?.id);
      const stage = await db.getStageById(parsed.stageId);
      if (!stage || stage.plan_id !== parsed.planId || stage.user_id !== user.id) {
        await safeAnswer(ctx, 'plan_trigger_error', true);
        return;
      }
      if (stage.kind !== 'trigger') {
        await safeAnswer(ctx, 'plan_trigger_error', true);
        return;
      }
      const dueAt = new Date(Date.now() + hoursToMs(DEFAULT_TRIGGER_DELAY_H));
      const events = await db.createEvents(
        buildEventPayloads(user.id, stage, dueAt).map((evt) => ({
          user_id: evt.user_id,
          plan_id: evt.plan_id,
          stage_id: evt.stage_id,
          type: evt.type,
          due_at: evt.due_at,
          status: evt.status,
        })),
      );
      const reminders = buildReminderPayloads(events);
      if (reminders.length) {
        await db.createReminders(reminders);
      }
      await safeAnswer(ctx, 'plan_trigger_scheduled');
    } catch (err) {
      console.error('plan_trigger error', err);
      await safeAnswer(ctx, 'plan_trigger_error', true);
    }
  };
}

function buildEventPayloads(userId, stage, dueAt) {
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

module.exports = { createPlanTriggerHandler };
