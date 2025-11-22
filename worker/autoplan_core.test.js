'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

const { processAutoplanContext, buildLocationDetails } = require('./autoplan_core');

function createBaseContext(overrides = {}) {
  return {
    run: { id: 1, min_hours_ahead: 2, horizon_hours: 48, stage_option_id: overrides.stage_option_id || null },
    user: { id: 10, tg_id: 77 },
    plan: { id: 5, object_id: 3 },
    stage: { id: 7, title: 'Опрыскивание', meta: { weather: { wind_max: 5 } } },
    object: { id: 3, name: 'Грядка', meta: overrides.meta || {}, location_tag: overrides.location_tag || 'Калуга' },
    ...overrides.extra,
  };
}

test('processAutoplanContext warns on default location and proposes slot', async () => {
  const updates = [];
  const slots = [];
  const timeSessions = [];
  const notices = [];
  const locations = [];
  const plannerSlot = {
    start: new Date('2025-01-01T10:00:00Z'),
    end: new Date('2025-01-01T12:00:00Z'),
    reason: ['clear'],
    score: 0.8,
  };
  const context = createBaseContext();
  const result = await processAutoplanContext(context, {
    planner: { findWindow: async () => plannerSlot },
    db: {
      updateAutoplanRun: async (id, patch) => updates.push({ id, patch }),
      upsertTreatmentSlot: async (payload) => {
        slots.push(payload);
        return { id: 99, ...payload };
      },
      updateObjectMeta: async () => {},
      logFunnelEvent: async () => {},
    },
    fallbackLat: 55.75,
    fallbackLon: 37.61,
    trackLocation: async (_ctx, location) => locations.push(location),
    maybeNotifyDefaultLocation: async (_ctx, location) => notices.push(location),
    sendSlotCard: async (_ctx, slot) => slots.push({ sent: slot.id }),
    notifyNoWindow: async () => {},
    notifyFailure: async () => {},
    updateTimeSession: async (planId, payload) => timeSessions.push({ planId, payload }),
    strings: { plan_autoplan_default_location: 'Использую стандартные координаты{details}.' },
  });

  assert.equal(result.status, 'slot_proposed');
  assert.equal(slots[0].plan_id, 5);
  assert.equal(slots[0].autoplan_run_id, 1);
  assert.equal(slots[0].reason[0], 'clear');
  assert.equal(slots[1].sent, 99); // sendSlotCard called
  assert.ok(updates.find((u) => u.patch.status === 'in_progress'));
  assert.ok(updates.find((u) => u.patch.status === 'awaiting_confirmation'));
  assert.equal(locations[0].source, 'default');
  assert.equal(locations[0].label, 'Калуга');
  assert.equal(notices.length, 1);
  assert.ok(timeSessions[0].payload.state.slotId);
});

test('processAutoplanContext skips default notice when coordinates present and handles no window', async () => {
  const updates = [];
  const noWindow = [];
  const locations = [];
  const context = createBaseContext({ meta: { lat: 48.5, lon: 44.5, location_source: 'manual' } });
  const result = await processAutoplanContext(context, {
    planner: { findWindow: async () => null },
    db: {
      updateAutoplanRun: async (id, patch) => updates.push({ id, patch }),
      upsertTreatmentSlot: async () => {
        throw new Error('should not upsert slot');
      },
    },
    fallbackLat: 0,
    fallbackLon: 0,
    trackLocation: async (_ctx, location) => locations.push(location),
    maybeNotifyDefaultLocation: async () => {
      throw new Error('should not notify default');
    },
    notifyNoWindow: async () => noWindow.push(true),
    notifyFailure: async () => {},
  });

  assert.equal(result.status, 'awaiting_window');
  assert.equal(locations[0].source, 'manual');
  assert.ok(updates.find((u) => u.patch.status === 'awaiting_window'));
  assert.equal(noWindow.length, 1);
});

test('buildLocationDetails renders label and coords', () => {
  const details = buildLocationDetails({ lat: 55.7, lon: 37.6, label: 'Москва' });
  assert.equal(details, ': возле Москва • 55.70000, 37.60000');
});
