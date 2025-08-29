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

test('history treats negative offset as 0', async () => {
  let received;
  pool.query = async (sql, params) => {
    received = params;
    return { rows: [] };
  };
  const res = await app.inject('/v1/photos/history?offset=-5');
  assert.equal(res.statusCode, 200);
  assert.equal(received[2], 0);
});

test('history maps null confidence to null', async () => {
  pool.query = async () => {
    return {
      rows: [
        {
          photo_id: 1,
          ts: new Date().toISOString(),
          crop: 'apple',
          disease: 'scab',
          status: 'ok',
          confidence: null,
          file_id: 'f.jpg',
        },
      ],
    };
  };
  const res = await app.inject('/v1/photos/history');
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body[0].confidence, null);
});
