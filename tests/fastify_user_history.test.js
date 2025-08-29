const { test, mock } = require('node:test');
const assert = require('node:assert/strict');
const { S3Client } = require('@aws-sdk/client-s3');
const { app, pool } = require('../fastify');

test('diagnose logs photo under provided user id', async (t) => {
  const inserted = [];
  const rowsByUser = {};
  pool.query = async (sql, params) => {
    if (sql.startsWith('INSERT')) {
      const [userId, key, status] = params;
      inserted.push({ userId, key });
      rowsByUser[userId] = [
        {
          photo_id: 1,
          ts: new Date('2024-01-01T00:00:00Z'),
          crop: 'apple',
          disease: 'powdery mildew',
          status,
          confidence: 0.9,
          file_id: key,
        },
      ];
      return { rows: [] };
    }
    if (sql.startsWith('SELECT')) {
      const [userId] = params;
      return { rows: rowsByUser[userId] || [] };
    }
    return { rows: [] };
  };

  const mockedSend = mock.method(S3Client.prototype, 'send', async () => ({}));
  t.after(() => mockedSend.mock.restore());

  const payload = { image_base64: Buffer.from('x').toString('base64') };
  await app.inject({
    method: 'POST',
    url: '/v1/ai/diagnose',
    headers: { 'content-type': 'application/json', 'x-user-id': '7' },
    payload,
  });

  const res = await app.inject({
    method: 'GET',
    url: '/v1/photos/history',
    headers: { 'x-user-id': '7' },
  });

  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.length, 1);
  assert.ok(body[0].thumb_url.endsWith(inserted[0].key));

  const other = await app.inject({
    method: 'GET',
    url: '/v1/photos/history',
    headers: { 'x-user-id': '8' },
  });
  assert.equal(other.json().length, 0);
});
