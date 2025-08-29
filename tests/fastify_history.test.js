const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { app, pool } = require('../fastify');

const secret = process.env.HMAC_SECRET || 'test-hmac-secret';
function tokenFor(userId) {
  const id = String(userId);
  const sig = crypto.createHmac('sha256', secret).update(id).digest('hex');
  return `${id}:${sig}`;
}

test('history uses limit and offset', async () => {
  let received;
  pool.query = async (sql, params) => {
    received = params;
    return { rows: [] };
  };
  const res = await app.inject({
    url: '/v1/photos/history?limit=5&offset=2',
    headers: { Authorization: `Bearer ${tokenFor(1)}` },
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(received, [1, 5, 2]);
});

test('history caps limit at 50', async () => {
  let received;
  pool.query = async (sql, params) => {
    received = params;
    return { rows: [] };
  };
  const res = await app.inject({
    url: '/v1/photos/history?limit=99',
    headers: { Authorization: `Bearer ${tokenFor(1)}` },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(received[1], 50);
});

test('history treats negative offset as 0', async () => {
  let received;
  pool.query = async (sql, params) => {
    received = params;
    return { rows: [] };
  };
  const res = await app.inject({
    url: '/v1/photos/history?offset=-5',
    headers: { Authorization: `Bearer ${tokenFor(1)}` },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(received[2], 0);
});

test('history requires auth', async () => {
  const res = await app.inject('/v1/photos/history');
  assert.equal(res.statusCode, 401);
});

test('history rejects invalid token', async () => {
  const bad = tokenFor(1) + 'bad';
  const res = await app.inject({
    url: '/v1/photos/history',
    headers: { Authorization: `Bearer ${bad}` },
  });
  assert.equal(res.statusCode, 401);
});

test('history ignores x-user-id header', async () => {
  let received;
  pool.query = async (sql, params) => {
    received = params;
    return { rows: [] };
  };
  const res = await app.inject({
    url: '/v1/photos/history',
    headers: {
      Authorization: `Bearer ${tokenFor(7)}`,
      'x-user-id': '2',
    },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(received[0], 7);
});
