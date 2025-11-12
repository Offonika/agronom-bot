'use strict';

const { msg } = require('./utils');

function createPlanCommands({ db, planWizard }) {
  if (!db || !planWizard) throw new Error('planCommands requires db and planWizard');

  async function ensureUser(ctx) {
    if (!ctx.from?.id) throw new Error('no user');
    return db.ensureUser(ctx.from.id);
  }

  async function ensureActiveObject(user) {
    if (user.last_object_id) {
      const current = await db.getObjectById(user.last_object_id);
      if (current) return current;
    }
    const list = await db.listObjects(user.id);
    if (list.length) {
      await db.updateUserLastObject(user.id, list[0].id);
      return list[0];
    }
    const created = await db.createObject(user.id, {
      name: msg('object.default_name'),
      meta: { source: 'cmd' },
    });
    await db.updateUserLastObject(user.id, created.id);
    return created;
  }

  async function handleObjects(ctx) {
    try {
      const user = await ensureUser(ctx);
      const objects = await db.listObjects(user.id);
      if (!objects.length) {
        const created = await db.createObject(user.id, {
          name: msg('object.default_name'),
          meta: { source: 'cmd' },
        });
        objects.push(created);
        await db.updateUserLastObject(user.id, created.id);
      }
      const lines = objects.map((obj) => {
        const marker = obj.id === user.last_object_id ? '✅' : '▫️';
        return `${marker} ${obj.name} (#${obj.id})`;
      });
      await ctx.reply(msg('objects_list', { list: lines.join('\n') }));
    } catch (err) {
      console.error('objects command error', err);
      await ctx.reply(msg('objects_error'));
    }
  }

  async function handleUse(ctx) {
    const [, arg] = ctx.message?.text?.split(' ') ?? [];
    const targetId = Number(arg);
    if (!targetId) {
      await ctx.reply(msg('objects_use_hint'));
      return;
    }
    try {
      const user = await ensureUser(ctx);
      const objects = await db.listObjects(user.id);
      const target = objects.find((obj) => obj.id === targetId);
      if (!target) {
        await ctx.reply(msg('objects_not_found'));
        return;
      }
      await db.updateUserLastObject(user.id, target.id);
      await ctx.reply(msg('objects_switched', { name: target.name }));
    } catch (err) {
      console.error('use command error', err);
      await ctx.reply(msg('objects_error'));
    }
  }

  async function handlePlans(ctx) {
    try {
      const user = await ensureUser(ctx);
      const object = await ensureActiveObject(user);
      const plans = await db.listPlansByObject(object.id, 5);
      if (!plans.length) {
        await ctx.reply(msg('plans_empty', { object: object.name }));
        return;
      }
      const lines = plans.map(
        (plan) => `#${plan.id} • ${plan.title} (${plan.scheduled_events || 0} ${msg('plans_events_suffix')})`,
      );
      await ctx.reply(msg('plans_list', { object: object.name, list: lines.join('\n') }));
    } catch (err) {
      console.error('plans command error', err);
      await ctx.reply(msg('plans_error'));
    }
  }

  async function handlePlan(ctx) {
    const [, arg] = ctx.message?.text?.split(' ') ?? [];
    const planId = Number(arg);
    if (!planId) {
      await ctx.reply(msg('plan_hint'));
      return;
    }
    try {
      const user = await ensureUser(ctx);
      const plan = await db.getPlanForUser(planId, user.id);
      if (!plan) {
        await ctx.reply(msg('plan_not_found'));
        return;
      }
      await ctx.reply(msg('plan_show_intro', { title: plan.title }));
      await planWizard.showPlanTable(ctx.chat.id, plan.id);
    } catch (err) {
      console.error('plan command error', err);
      await ctx.reply(msg('plan_error'));
    }
  }

  async function markEvent(ctx, status) {
    try {
      const user = await ensureUser(ctx);
      const event = await db.getNextScheduledEvent(user.id);
      if (!event) {
        await ctx.reply(msg('events_none'));
        return;
      }
      const stageName = event.stage_title || msg('reminder_stage_fallback');
      await db.updateEventStatus(event.id, status, new Date());
      const key = status === 'done' ? 'event_marked_done' : 'event_marked_skipped';
      await ctx.reply(msg(key, { stage: stageName, plan: event.plan_title || '' }));
    } catch (err) {
      console.error('event command error', err);
      await ctx.reply(msg('events_error'));
    }
  }

  return {
    handleObjects,
    handleUse,
    handlePlans,
    handlePlan,
    handleDone: (ctx) => markEvent(ctx, 'done'),
    handleSkip: (ctx) => markEvent(ctx, 'skipped'),
  };
}

module.exports = { createPlanCommands };
