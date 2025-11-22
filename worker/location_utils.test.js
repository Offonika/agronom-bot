'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

const { resolveObjectLocation } = require('./location_utils');

test('resolveObjectLocation returns manual coordinates', () => {
  const meta = { lat: 55.7, lon: 37.6, location_source: 'manual', geo_label: 'Москва' };
  const result = resolveObjectLocation(meta, 50, 40, 'Фолбэк');
  assert.equal(result.lat, 55.7);
  assert.equal(result.lon, 37.6);
  assert.equal(result.source, 'manual');
  assert.ok(!result.warned);
  assert.equal(result.label, 'Москва');
});

test('resolveObjectLocation respects geo_auto source and warned flag', () => {
  const meta = { lat: '45.1', lon: '12.3', location_source: 'geo_auto', location_default_warned: true };
  const result = resolveObjectLocation(meta, 0, 0);
  assert.equal(result.source, 'geo_auto');
  assert.equal(result.lat, 45.1);
  assert.ok(result.warned);
});

test('resolveObjectLocation falls back to defaults when no coordinates', () => {
  const meta = {};
  const result = resolveObjectLocation(meta, 10, 20, 'Калуга');
  assert.equal(result.source, 'default');
  assert.equal(result.lat, 10);
  assert.equal(result.lon, 20);
  assert.equal(result.label, 'Калуга');
});
