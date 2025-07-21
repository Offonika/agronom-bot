const assert = require('node:assert/strict');
const { test } = require('node:test');
const { photoHandler, messageHandler } = require('./handlers');

test('photoHandler stores info and replies', async () => {
  const calls = [];
  const pool = { query: async (...args) => { calls.push(args); } };
  const replies = [];
  const ctx = {
    message: { photo: [{ file_id: 'id1', file_unique_id: 'uid', width: 1, height: 2, file_size: 3 }] },
    from: { id: 42 },
    reply: async (msg) => replies.push(msg),
  };
  await photoHandler(pool, ctx);
  assert.equal(calls.length, 1);
  assert.equal(replies[0], 'Фото получено');
});

test('messageHandler ignores non-photo', () => {
  let logged = '';
  const orig = console.log;
  console.log = (msg) => { logged = msg; };
  messageHandler({ message: { text: 'hi' } });
  console.log = orig;
  assert.equal(logged, 'Ignoring non-photo message');
});
