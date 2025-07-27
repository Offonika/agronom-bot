const { test } = require('node:test');
const assert = require('node:assert/strict');
const { app, pool } = require('../fastify');

test('history uses limit and offset', async () => {
  let received;
  pool.query = async (sql, params) => {
    received = params;
    return { rows: [] };
  };
  const res = await app.inject('/v1/photos/history?limit=5&offset=2');
  assert.equal(res.statusCode, 200);
  assert.deepEqual(received, [1, 5, 2]);
});

test('history caps limit at 50', async () => {
  let received;
  pool.query = async (sql, params) => {
    received = params;
    return { rows: [] };
  };
  const res = await app.inject('/v1/photos/history?limit=99');
  assert.equal(res.statusCode, 200);
  assert.equal(received[1], 50);
});
