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
    telegram: { getFileLink: async () => ({ href: 'http://file' }) },
  };
  const origFetch = global.fetch;
  global.fetch = async (url) => {
    if (url === 'http://file') {
      return { arrayBuffer: async () => Buffer.from('x') };
    }
    return { json: async () => ({ crop: 'apple', disease: 'scab', confidence: 0.9 }) };
  };
  await photoHandler(pool, ctx);
  global.fetch = origFetch;
  assert.equal(calls.length, 1);
  assert.ok(replies[0].includes('Культура'));
});

test('messageHandler ignores non-photo', () => {
  let logged = '';
  const orig = console.log;
  console.log = (msg) => { logged = msg; };
  messageHandler({ message: { text: 'hi' } });
  console.log = orig;
  assert.equal(logged, 'Ignoring non-photo message');
});
