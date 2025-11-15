'use strict';

const { msg } = require('./utils');

function createPlanCommands({ db, planWizard, objectChips }) {
  if (!db || !planWizard) throw new Error('planCommands requires db and planWizard');

  function formatDueDate(value) {
    if (!value) return msg('plans_due_unknown');
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return msg('plans_due_unknown');
    return date.toLocaleString('ru-RU', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
  }

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
      if (objectChips) {
        await objectChips.send(ctx);
      }
    } catch (err) {
      console.error('objects command error', err);
      await ctx.reply(msg('objects_error'));
    }
  }

  async function handleUse(ctx) {
    const [, arg] = ctx.message?.text?.split(' ') ?? [];
    const targetId = (arg || '').trim();
    if (!targetId) {
      await ctx.reply(msg('objects_use_hint'));
      return;
    }
    try {
      const user = await ensureUser(ctx);
      const objects = await db.listObjects(user.id);
      const target = objects.find((obj) => String(obj.id) === targetId);
      if (!target) {
        await ctx.reply(msg('objects_not_found'));
        return;
      }
      await db.updateUserLastObject(user.id, target.id);
      await ctx.reply(msg('objects_switched', { name: target.name }));
      if (objectChips) {
        await objectChips.send(ctx);
      }
    } catch (err) {
      console.error('use command error', err);
      await ctx.reply(msg('objects_error'));
    }
  }

  async function handlePlans(ctx) {
    try {
      const user = await ensureUser(ctx);
      const events = await db.listUpcomingEventsByUser(user.id, 5);
      if (!events.length) {
        await ctx.reply(msg('plans_empty_overview'));
        return;
      }
      const lines = events.map((event) => {
        const due = formatDueDate(event.due_at);
        return `#${event.plan_id} • ${event.plan_title || msg('plans_title_unknown')} — ${due}`;
      });
      await ctx.reply(msg('plans_overview', { list: lines.join('\n') }));
      for (const event of events) {
        const keyboard = {
          inline_keyboard: [
            [
              { text: msg('plans_action_done'), callback_data: `plan_event|done|${event.id}` },
              { text: msg('plans_action_reschedule'), callback_data: `plan_event|reschedule|${event.id}` },
            ],
            [
              { text: msg('plans_action_cancel'), callback_data: `plan_event|cancel|${event.id}` },
              { text: msg('plans_action_open'), callback_data: `plan_event|open|${event.plan_id}` },
            ],
          ],
        };
        await ctx.reply(
          msg('plans_event_card', {
            plan: event.plan_title || msg('plans_title_unknown'),
            stage: event.stage_title || msg('reminder_stage_fallback'),
            due: formatDueDate(event.due_at),
            eventId: event.id,
          }),
          { reply_markup: keyboard },
        );
      }
      if (objectChips) {
        await objectChips.send(ctx);
      }
    } catch (err) {
      console.error('plans command error', err);
      await ctx.reply(msg('plans_error'));
    }
  }

  async function handlePlan(ctx) {
    const [, arg] = ctx.message?.text?.split(' ') ?? [];
    const planId = (arg || '').trim();
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
      await planWizard.showPlanTable(ctx.chat.id, plan.id, {
        userId: user.id,
        diffAgainst: 'accepted',
      });
      if (objectChips) {
        await objectChips.send(ctx);
      }
    } catch (err) {
      console.error('plan command error', err);
      await ctx.reply(msg('plan_error'));
    }
  }

  async function handleEventAction(ctx, action, target) {
    try {
      const user = await ensureUser(ctx);
      if (action === 'open') {
        const planId = Number(target);
        if (!planId) {
          await ctx.reply(msg('plan_not_found'));
          return;
        }
        const plan = await db.getPlanForUser(planId, user.id);
        if (!plan) {
          await ctx.reply(msg('plan_not_found'));
          return;
        }
        await ctx.reply(msg('plan_show_intro', { title: plan.title }));
        await planWizard.showPlanTable(ctx.chat.id, plan.id, {
          userId: user.id,
          diffAgainst: 'accepted',
        });
        return;
      }
      const eventId = Number(target);
      if (!eventId) {
        await ctx.reply(msg('plans_event_missing'));
        return;
      }
      const event = await db.getEventByIdForUser(eventId, user.id);
      if (!event) {
        await ctx.reply(msg('plans_event_missing'));
        return;
      }
      const stageName = event.stage_title || msg('reminder_stage_fallback');
      const planName = event.plan_title || msg('plans_title_unknown');
      if (action === 'done') {
        await db.updateEventStatus(event.id, 'done', new Date());
        await ctx.reply(msg('event_marked_done', { stage: stageName, plan: planName }));
      } else if (action === 'cancel') {
        await db.updateEventStatus(event.id, 'cancelled', new Date());
        await ctx.reply(msg('event_marked_cancelled', { stage: stageName, plan: planName }));
      } else if (action === 'reschedule') {
        const base = event.due_at ? new Date(event.due_at) : new Date();
        base.setDate(base.getDate() + 1);
        await db.updateEventStatus(event.id, 'scheduled', null, base);
        await ctx.reply(msg('plans_rescheduled', { when: formatDueDate(base) }));
      } else {
        await ctx.reply(msg('plans_error'));
      }
    } catch (err) {
      console.error('event action error', err);
      await ctx.reply(msg('events_error'));
    }
  }

  async function handleStats(ctx) {
    try {
      const crops = typeof db.getTopCrops === 'function' ? await db.getTopCrops(5, 30) : [];
      const diseases = typeof db.getTopDiseases === 'function' ? await db.getTopDiseases(5, 30) : [];
      if (!crops.length && !diseases.length) {
        await ctx.reply(msg('stats_empty'));
        return;
      }
      const cropLines = crops.map((row, idx) => `${idx + 1}. ${row.name} — ${row.cnt}`);
      const diseaseLines = diseases.map((row, idx) => `${idx + 1}. ${row.name} — ${row.cnt}`);
      const text = msg('stats_overview', {
        crops: cropLines.join('\n') || msg('stats_none'),
        diseases: diseaseLines.join('\n') || msg('stats_none'),
      });
      await ctx.reply(text);
    } catch (err) {
      console.error('stats command error', err);
      await ctx.reply(msg('stats_error'));
    }
  }

  async function markNextEvent(ctx, status) {
    try {
      const user = await ensureUser(ctx);
      const event = await db.getNextScheduledEvent(user.id);
      if (!event) {
        await ctx.reply(msg('events_none'));
        return;
      }
      const targetStatus = status === 'cancel' ? 'cancelled' : status;
      const stageName = event.stage_title || msg('reminder_stage_fallback');
      await db.updateEventStatus(event.id, targetStatus, new Date());
      const key =
        targetStatus === 'done'
          ? 'event_marked_done'
          : targetStatus === 'cancelled'
            ? 'event_marked_cancelled'
            : 'event_marked_skipped';
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
    handleEventAction,
    handlePlan,
    handleDone: (ctx) => markNextEvent(ctx, 'done'),
    handleSkip: (ctx) => markNextEvent(ctx, 'skipped'),
    handleStats,
  };
}

module.exports = { createPlanCommands };
