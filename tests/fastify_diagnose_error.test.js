const { test, mock } = require('node:test');
const assert = require('node:assert/strict');
const { S3Client } = require('@aws-sdk/client-s3');
const { app, pool } = require('../fastify');

test('diagnose returns 500 on S3 error', async (t) => {
  const mockedSend = mock.method(S3Client.prototype, 'send', async () => {
    throw new Error('S3 fail');
  });
  t.after(() => mockedSend.mock.restore());
  pool.query = async () => ({ rows: [] });

  const res = await app.inject({
    method: 'POST',
    url: '/v1/ai/diagnose',
    headers: { 'content-type': 'application/json' },
    payload: { image_base64: Buffer.from('x').toString('base64') },
  });

  assert.equal(res.statusCode, 500);
  assert.equal(res.json().code, 'SERVICE_UNAVAILABLE');
});
