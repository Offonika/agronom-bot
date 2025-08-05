const assert = require('node:assert/strict');
const { test } = require('node:test');
const { notifyExpiringUsers } = require('./pro_expiry_notify');

test('sends notifications to expiring users', async () => {
  const pool = {
    connect: async () => ({
      query: async () => ({ rows: [{ tg_id: 1 }, { tg_id: 2 }] }),
      release: () => {},
    }),
  };
  const sent = [];
  async function sendMessage(chatId, text) {
    sent.push({ chatId, text });
  }
  await notifyExpiringUsers(pool, sendMessage);
  assert.equal(sent.length, 2);
  assert.equal(sent[0].chatId, 1);
  assert.match(sent[0].text, /PRO/);
});
