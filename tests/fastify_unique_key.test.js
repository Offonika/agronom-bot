const { test, mock } = require('node:test');
const assert = require('node:assert/strict');
const { S3Client } = require('@aws-sdk/client-s3');
const crypto = require('crypto');
const { app, pool } = require('../fastify');

test('diagnose uses unique filename', async (t) => {
  const keys = [];
  const mockedDate = mock.method(Date, 'now', () => 1700000000000);
  let uuidCount = 0;
  const mockedUUID = mock.method(crypto, 'randomUUID', () => String(uuidCount++));
  const mockedSend = mock.method(S3Client.prototype, 'send', async (cmd) => {
    keys.push(cmd.input.Key);
    return {};
  });
  t.after(() => {
    mockedDate.mock.restore();
    mockedUUID.mock.restore();
    mockedSend.mock.restore();
  });
  pool.query = async () => ({ rows: [] });
  const payload = { image_base64: Buffer.from('x').toString('base64') };
  await app.inject({
    method: 'POST',
    url: '/v1/ai/diagnose',
    headers: { 'content-type': 'application/json' },
    payload,
  });
  await app.inject({
    method: 'POST',
    url: '/v1/ai/diagnose',
    headers: { 'content-type': 'application/json' },
    payload,
  });
  assert.deepEqual(keys, ['1700000000000-0-base64.jpg', '1700000000000-1-base64.jpg']);
});
