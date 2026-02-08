'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

const { createAutoPlanner } = require('../services/auto_planner');

function buildForecast(base, hours, overrides = {}) {
  const entries = [];
  for (let i = 0; i < hours; i += 1) {
    entries.push({
      time: new Date(base.getTime() + i * 60 * 60 * 1000),
      precipitation: overrides.precipitation ?? 0,
      wind: overrides.wind ?? 3,
      temperature: overrides.temperature ?? 15,
    });
  }
  return entries;
}

test('auto planner finds earliest dry window', async () => {
  const start = new Date('2025-01-01T00:00:00Z');
  const weatherService = {
    getHourlyForecast: async () => {
      const entries = buildForecast(start, 24);
      entries[0].precipitation = 1;
      entries[1].precipitation = 0.3;
      return entries;
    },
  };
  const planner = createAutoPlanner({ weatherService, timezone: 'UTC' });
  const slot = await planner.findWindow({
    latitude: 10,
    longitude: 10,
    minHoursAhead: 0,
    horizonHours: 24,
    now: start,
    rules: { duration_min: 60, daylight_only: false },
  });
  assert.ok(slot);
  assert.equal(slot.start.toISOString(), '2025-01-01T04:00:00.000Z');
});

test('auto planner prefers user favorite hour when preference provided', async () => {
  const start = new Date('2025-01-01T00:00:00Z');
  const weatherService = {
    getHourlyForecast: async () => buildForecast(start, 12),
  };
  const planner = createAutoPlanner({ weatherService, timezone: 'UTC' });
  const preferences = {
    hourWeights: Array.from({ length: 24 }, (_, idx) => (idx === 6 ? 10 : 0)),
    maxCount: 10,
    total: 10,
  };
  const slot = await planner.findWindow({
    latitude: 10,
    longitude: 10,
    minHoursAhead: 0,
    horizonHours: 12,
    now: start,
    rules: { duration_min: 60, daylight_only: false },
    preferences,
  });
  assert.ok(slot);
  assert.equal(slot.start.toISOString(), '2025-01-01T06:00:00.000Z');
});

test('auto planner returns null when constraints violated', async () => {
  const start = new Date('2025-01-01T00:00:00Z');
  const weatherService = {
    getHourlyForecast: async () =>
      buildForecast(start, 4).map((entry) => ({ ...entry, precipitation: 0.5 })),
  };
  const planner = createAutoPlanner({ weatherService, timezone: 'UTC' });
  const slot = await planner.findWindow({
    latitude: 10,
    longitude: 10,
    minHoursAhead: 0,
    horizonHours: 4,
    now: start,
  });
  assert.equal(slot, null);
});

test('auto planner relaxes constraints when strict rules fail', async () => {
  const start = new Date('2025-01-01T00:00:00Z');
  const weatherService = {
    getHourlyForecast: async () => buildForecast(start, 12, { temperature: 0 }),
  };
  const planner = createAutoPlanner({ weatherService, timezone: 'UTC' });
  const slot = await planner.findWindow({
    latitude: 10,
    longitude: 10,
    minHoursAhead: 0,
    horizonHours: 12,
    now: start,
  });
  assert.ok(slot);
  assert.ok(slot.reason.some((line) => line.includes('Температура или ветер')));
});
