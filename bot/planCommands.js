'use strict';

const { msg } = require('./utils');
const {
  rememberLocationRequest,
  consumeLocationRequest,
  peekLocationRequest,
  clearLocationRequest,
} = require('./locationSession');

function createPlanCommands({ db, planWizard, objectChips, geocoder = null }) {
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

  function parseCoordinates(input) {
    if (!input || input.length < 2) return null;
    const lat = Number(input[0]);
    const lon = Number(input[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
    return { lat, lon };
  }

  function formatCoords(coords) {
    return `${coords.lat.toFixed(4)}, ${coords.lon.toFixed(4)}`;
  }

  async function updateObjectCoordinates(object, coords, source = 'manual') {
    if (!object?.id || !coords) return null;
    const patch = {
      lat: coords.lat,
      lon: coords.lon,
      location_source: source,
      location_updated_at: new Date().toISOString(),
    };
    return db.updateObjectMeta(object.id, patch);
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

  async function handlePlans(ctx, options = {}) {
    try {
      const user = await ensureUser(ctx);
      const objects = typeof db.listObjects === 'function' ? await db.listObjects(user.id) : [];
      const selectedObjectId = pickFilterObjectId(objects, options.objectId);
      const pageSize = 5;
      const cursorPayload = decodeCursor(options.cursor);
      const fetchLimit = pageSize + 1;
      const events = await db.listUpcomingEventsByUser(
        user.id,
        fetchLimit,
        selectedObjectId,
        cursorPayload,
      );
      if (!events.length) {
        const emptyKey = selectedObjectId ? 'plans_empty_filtered' : 'plans_empty_overview';
        await ctx.reply(
          msg(emptyKey, {
            name: selectedObjectId ? findObjectName(objects, selectedObjectId) : null,
          }),
        );
        return;
      }
      const hasMore = events.length > pageSize;
      const pageEvents = hasMore ? events.slice(0, pageSize) : events;
      if (!options.cursor && objects.length > 1) {
        const filterKeyboard = buildPlanFilters(objects, selectedObjectId);
        if (filterKeyboard.length) {
          await ctx.reply(msg('plans_filter_prompt'), { reply_markup: { inline_keyboard: filterKeyboard } });
        }
      }
      if (!options.cursor) {
        const lines = pageEvents.map((event) => {
          const due = formatDueDate(event.due_at);
          return `#${event.plan_id} • ${event.plan_title || msg('plans_title_unknown')} — ${due}`;
        });
        await ctx.reply(msg('plans_overview', { list: lines.join('\n') }));
        await ctx.reply(msg('plans_actions_hint'));
      } else {
        await ctx.reply(msg('plans_more_hint'));
      }
      const grouped = groupEventsByPlan(pageEvents);
      for (const group of grouped) {
        const header = buildPlanHeader(group);
        if (header) {
          const headerOpts =
            group.planId && group.planId > 0
              ? {
                  reply_markup: {
                    inline_keyboard: [
                      [{ text: msg('plans_plan_open_all'), callback_data: `plan_plan_open|${group.planId}` }],
                    ],
                  },
                }
              : undefined;
          await ctx.reply(header, headerOpts);
        }
        for (const event of group.events) {
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
              plan: group.planTitle || msg('plans_title_unknown'),
              stage: event.stage_title || msg('reminder_stage_fallback'),
              due: formatDueDate(event.due_at),
              eta: formatEta(event.due_at),
              eventId: event.id,
            }),
            { reply_markup: keyboard },
          );
        }
      }
      if (hasMore) {
        const last = pageEvents[pageEvents.length - 1];
        const cursorData = encodeCursor(last);
        const objectValue = selectedObjectId ?? 'all';
        await ctx.reply(msg('plans_more_hint'), {
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: msg('plans_more_button'),
                  callback_data: `plan_plans_more|${cursorData}|${objectValue}`,
                },
              ],
            ],
          },
        });
      }
      if (!options.cursor && typeof db.listOverdueEventsByUser === 'function') {
        const overdueEvents = await db.listOverdueEventsByUser(user.id, 3, selectedObjectId);
        if (overdueEvents.length) {
          await renderOverdueSection(ctx, overdueEvents);
        }
      }
      if (objectChips) {
        await objectChips.send(ctx);
      }
    } catch (err) {
      console.error('plans command error', err);
      await ctx.reply(msg('plans_error'));
    }
  }

  async function handleLocation(ctx) {
    try {
      const user = await ensureUser(ctx);
      const object = await ensureActiveObject(user);
      const args = ctx.message?.text?.split(' ').slice(1).filter(Boolean) ?? [];
      if (args.length >= 2) {
        clearLocationRequest(user.id);
        const coords = parseCoordinates(args);
        if (!coords) {
          await ctx.reply(msg('location_invalid_format'));
          return;
        }
        await updateObjectCoordinates(object, coords, 'manual_input');
        await ctx.reply(
          msg('location_updated', {
            name: object.name,
            coords: formatCoords(coords),
          }),
        );
        if (objectChips) {
          await objectChips.send(ctx);
        }
        return;
      }
      rememberLocationRequest(user.id, object.id);
      await ctx.reply(
        msg('location_prompt', {
          name: object.name,
        }),
      );
    } catch (err) {
      console.error('location command error', err);
      await ctx.reply(msg('location_error'));
    }
  }

  async function handleLocationShare(ctx) {
    const userId = ctx.from?.id;
    if (!userId) return;
    const location = ctx.message?.location;
    if (!location) return;
    const { entry, expired } = consumeLocationRequest(userId);
    if (!entry) {
      await ctx.reply(msg(expired ? 'location_request_expired' : 'location_no_request'));
      return;
    }
    try {
      const user = await ensureUser(ctx);
      const object = await db.getObjectById(entry.objectId);
      if (!object || object.user_id !== user.id) {
        await ctx.reply(msg('location_object_missing'));
        return;
      }
      const coords = { lat: Number(location.latitude), lon: Number(location.longitude) };
      if (!Number.isFinite(coords.lat) || !Number.isFinite(coords.lon)) {
        await ctx.reply(msg('location_invalid_format'));
        return;
      }
      if (coords.lat < -90 || coords.lat > 90 || coords.lon < -180 || coords.lon > 180) {
        await ctx.reply(msg('location_invalid_format'));
        return;
      }
      await updateObjectCoordinates(object, coords, 'manual_location');
      await ctx.reply(
        msg('location_updated', {
          name: object.name,
          coords: formatCoords(coords),
        }),
      );
    } catch (err) {
      console.error('location share error', err);
      await ctx.reply(msg('location_error'));
    }
  }

  async function handleLocationText(ctx) {
    const userId = ctx.from?.id;
    const text = ctx.message?.text?.trim();
    if (!userId || !text) return false;
    const { entry, expired } = peekLocationRequest(userId);
    if (!entry) {
      if (expired) {
        await ctx.reply(msg('location_request_expired'));
        return true;
      }
      return false;
    }
    if (entry.mode !== 'address') return false;
    consumeLocationRequest(userId);
    if (!geocoder) {
      await ctx.reply(msg('location_address_geocoder_missing'));
      return true;
    }
    try {
      const geo = await geocoder.lookup(text, { language: 'ru' });
      if (!geo || !Number.isFinite(geo.lat) || !Number.isFinite(geo.lon)) {
        await ctx.reply(msg('location_address_not_found'));
        rememberLocationRequest(userId, entry.objectId, 'address');
        return true;
      }
      const user = await ensureUser(ctx);
      const object = await db.getObjectById(entry.objectId);
      if (!object || object.user_id !== user.id) {
        await ctx.reply(msg('location_object_missing'));
        return true;
      }
      await updateObjectCoordinates(object, { lat: geo.lat, lon: geo.lon }, 'manual_address');
      await ctx.reply(
        msg('location_updated', {
          name: object.name,
          coords: formatCoords({ lat: geo.lat, lon: geo.lon }),
        }),
      );
      if (objectChips) {
        await objectChips.send(ctx);
      }
    } catch (err) {
      console.error('location text error', err);
      await ctx.reply(msg('location_error'));
    }
    return true;
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
        await openPlan(ctx, user, planId);
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
      const keyboard = buildManualStartKeyboard(event);
      if (!keyboard) {
        await ctx.reply(msg('plans_event_missing'));
        return;
      }
      await db.updateEventStatus(event.id, 'cancelled', new Date());
      await ctx.reply(
        msg('plans_reschedule_pick_time', {
          stage: stageName,
          plan: planName,
        }),
        { reply_markup: keyboard },
      );
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

  async function openPlan(ctx, user, planId) {
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
  }

  function buildManualStartKeyboard(event) {
    if (!event?.plan_id || !event?.stage_id) return null;
    const optionId = event.stage_option_id || 0;
    return {
      inline_keyboard: [
        [
          {
            text: msg('plan_manual_start_button'),
            callback_data: `plan_manual_start|${event.plan_id}|${event.stage_id}|${optionId}`,
          },
        ],
      ],
    };
  }

  function pickFilterObjectId(objects, requestedId) {
    if (!requestedId) return null;
    const numeric = Number(requestedId);
    if (!Number.isFinite(numeric)) return null;
    return objects.some((obj) => Number(obj.id) === numeric) ? numeric : null;
  }

  function findObjectName(objects, objectId) {
    if (!objectId) return '';
    const target = objects.find((obj) => Number(obj.id) === Number(objectId));
    return target?.name || '';
  }

  function buildPlanFilters(objects, activeId) {
    if (!Array.isArray(objects) || objects.length < 2) return [];
    const entries = [{ id: null, label: msg('plans_filter_all') || 'Все объекты' }, ...objects];
    const buttons = entries.map((entry) => {
      const isActive = entry.id == null ? !activeId : Number(entry.id) === Number(activeId);
      const text = isActive ? `✅ ${entry.label}` : entry.label;
      const value = entry.id == null ? 'all' : entry.id;
      return {
        text,
        callback_data: `plan_plans_filter|${value}`,
      };
    });
    return chunkButtons(buttons, 2);
  }

  function chunkButtons(items, size) {
    const rows = [];
    for (let i = 0; i < items.length; i += size) {
      rows.push(items.slice(i, i + size));
    }
    return rows;
  }

  function groupEventsByPlan(events) {
    const map = new Map();
    for (const event of events) {
      const key = event.plan_id;
      if (!map.has(key)) {
        map.set(key, {
          planId: event.plan_id,
          planTitle: event.plan_title || null,
          objectName: event.object_name || null,
          events: [],
        });
      }
      map.get(key).events.push(event);
    }
    return Array.from(map.values());
  }

  function buildPlanHeader(group) {
    if (!group) return '';
    const planName = group.planTitle || msg('plans_title_unknown');
    if (group.objectName) {
      return msg('plans_plan_header', { plan: planName, object: group.objectName });
    }
    return msg('plans_plan_header_plain', { plan: planName });
  }

  async function renderOverdueSection(ctx, events) {
    const grouped = groupEventsByPlan(events);
    const ids = events.map((e) => e.id).join(',');
    const inline_keyboard = [
      [
        { text: msg('plans_overdue_mark_done'), callback_data: `plan_overdue_bulk|done|${ids}` },
        { text: msg('plans_overdue_reschedule'), callback_data: `plan_overdue_bulk|later|${ids}` },
      ],
    ];
    await ctx.reply(msg('plans_overdue_header'), { reply_markup: { inline_keyboard } });
    for (const group of grouped) {
      const header = buildPlanHeader(group);
      if (header) {
        await ctx.reply(header);
      }
      for (const event of group.events) {
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
            plan: group.planTitle || msg('plans_title_unknown'),
            stage: event.stage_title || msg('reminder_stage_fallback'),
            due: formatDueDate(event.due_at),
            eta: formatEta(event.due_at),
            eventId: event.id,
          }),
          { reply_markup: keyboard },
        );
      }
    }
  }

  function encodeCursor(event) {
    if (!event?.due_at || !event?.id) return '';
    const date = event.due_at instanceof Date ? event.due_at : new Date(event.due_at);
    const dueAt = Number(date.getTime());
    return `${dueAt}:${event.id}`;
  }

  function decodeCursor(raw) {
    if (!raw) return null;
    const [dueStr, idStr] = String(raw).split(':');
    const dueAt = Number(dueStr);
    const eventId = Number(idStr);
    if (!Number.isFinite(dueAt) || !Number.isFinite(eventId)) return null;
    return { dueAt: new Date(dueAt), eventId };
  }

  function formatEta(value) {
    if (!value) return '';
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    const diffMs = date.getTime() - Date.now();
    const minutes = Math.round(diffMs / 60000);
    if (minutes >= 60) {
      const hours = Math.round(minutes / 60);
      if (hours >= 24) {
        const days = Math.round(hours / 24);
        return msg('plans_eta_in_days', { value: days });
      }
      return msg('plans_eta_in_hours', { value: hours });
    }
    if (minutes >= 1) {
      return msg('plans_eta_in_minutes', { value: minutes });
    }
    if (minutes < 0) {
      const overdueDays = Math.max(1, Math.round(Math.abs(minutes) / (60 * 24)));
      return msg('plans_eta_overdue', { value: overdueDays });
    }
    return msg('plans_eta_in_minutes', { value: 0 });
  }

  return {
    handleObjects,
    handleUse,
    handlePlans,
    handlePlansFilter: (ctx, objectId) => handlePlans(ctx, { objectId }),
    handleOverdueBulk,
    handleEventAction,
    handlePlan,
    handleLocation,
    handleLocationShare,
    handleLocationText,
    handleDone: (ctx) => markNextEvent(ctx, 'done'),
    handleSkip: (ctx) => markNextEvent(ctx, 'skipped'),
    handleStats,
  };
}

module.exports = { createPlanCommands };
  async function handleOverdueBulk(ctx, action, idList) {
    const ids = parseIdList(idList);
    if (!ids.length) {
      await ctx.reply(msg('plans_event_missing'));
      return;
    }
    try {
      const user = await ensureUser(ctx);
      if (action === 'done') {
        for (const eventId of ids) {
          await db.updateEventStatus(eventId, 'done', new Date());
        }
        await ctx.reply(msg('plans_overdue_done', { count: ids.length }));
      } else if (action === 'later') {
        for (const eventId of ids) {
          const event = await db.getEventByIdForUser(eventId, user.id);
          if (!event) continue;
          const nextDay = new Date();
          nextDay.setDate(nextDay.getDate() + 1);
          await db.updateEventStatus(eventId, 'scheduled', null, nextDay);
        }
        await ctx.reply(msg('plans_overdue_rescheduled_toast', { count: ids.length }));
      } else {
        await ctx.reply(msg('plans_error'));
      }
    } catch (err) {
      console.error('overdue bulk error', err);
      await ctx.reply(msg('plans_error'));
    }
  }

  function parseIdList(raw) {
    if (!raw) return [];
    return raw
      .split(',')
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value) && value > 0);
  }
