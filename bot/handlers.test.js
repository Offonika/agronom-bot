const assert = require('node:assert/strict');
const { test } = require('node:test');

process.env.FREE_PHOTO_LIMIT = '5';
const { photoHandler, messageHandler, subscribeHandler } = require('./handlers');

async function withMockFetch(responses, fn) {
  const origFetch = global.fetch;
  global.fetch = async (url) => {
    if (Object.prototype.hasOwnProperty.call(responses, url)) {
      return responses[url];
    }
    if (responses.default) {
      return responses.default;
    }
    throw new Error(`Unexpected fetch ${url}`);
  };
  try {
    await fn();
  } finally {
    global.fetch = origFetch;
  }
}

test('photoHandler stores info and replies', async () => {
  const calls = [];
  const pool = { query: async (...args) => { calls.push(args); } };
  const replies = [];
  const ctx = {
    message: { photo: [{ file_id: 'id1', file_unique_id: 'uid', width: 1, height: 2, file_size: 3 }] },
    from: { id: 42 },
    reply: async (msg, opts) => replies.push({ msg, opts }),
    telegram: { getFileLink: async () => ({ href: 'http://file' }) },
  };
  await withMockFetch({
    'http://file': { arrayBuffer: async () => Buffer.from('x') },
    default: { json: async () => ({ crop: 'apple', disease: 'scab', confidence: 0.9 }) },
  }, async () => {
    await photoHandler(pool, ctx);
  });
  assert.equal(calls.length, 1);
  assert.ok(replies[0].msg.includes('Культура'));
  assert.ok(replies[0].opts.reply_markup.inline_keyboard.length > 0);
});

test('messageHandler ignores non-photo', () => {
  let logged = '';
  const orig = console.log;
  console.log = (msg) => { logged = msg; };
  messageHandler({ message: { text: 'hi' } });
  console.log = orig;
  assert.equal(logged, 'Ignoring non-photo message');
});

test('photoHandler sends protocol buttons', async () => {
  const pool = { query: async () => {} };
  const replies = [];
  const ctx = {
    message: { photo: [{ file_id: 'id1', file_unique_id: 'u', width: 1, height: 1, file_size: 1 }] },
    from: { id: 99 },
    reply: async (msg, opts) => replies.push({ msg, opts }),
    telegram: { getFileLink: async () => ({ href: 'http://file' }) },
  };
  await withMockFetch({
    'http://file': { arrayBuffer: async () => Buffer.from('x') },
    default: {
      json: async () => ({
        crop: 'apple',
        disease: 'powdery_mildew',
        confidence: 0.9,
        protocol: {
          id: 1,
          product: 'Скор 250 ЭК',
          dosage_value: 2,
          dosage_unit: 'ml_10l',
          phi: 30,
        },
      }),
    },
  }, async () => {
    await photoHandler(pool, ctx);
  });
  const buttons = replies[0].opts.reply_markup.inline_keyboard[0];
  assert.equal(buttons[0].text, 'Показать протокол');
  assert.equal(buttons[0].callback_data, 'proto|Скор 250 ЭК|2|ml_10l|30');
  assert.ok(buttons[1].url.includes('pid=1'));
});

test('photoHandler beta without protocol', async () => {
  const pool = { query: async () => {} };
  const replies = [];
  const ctx = {
    message: { photo: [{ file_id: 'id2', file_unique_id: 'u', width: 1, height: 1, file_size: 1 }] },
    from: { id: 100 },
    reply: async (msg, opts) => replies.push({ msg, opts }),
    telegram: { getFileLink: async () => ({ href: 'http://file' }) },
  };
  await withMockFetch({
    'http://file': { arrayBuffer: async () => Buffer.from('x') },
    default: { json: async () => ({ crop: 'apple', disease: 'scab', confidence: 0.9 }) },
  }, async () => {
    await photoHandler(pool, ctx);
  });
  const button = replies[0].opts.reply_markup.inline_keyboard[0][0];
  assert.equal(button.callback_data, 'ask_expert');
});

test('photoHandler paywall on 402', async () => {
  const pool = { query: async () => {} };
  const replies = [];
  const ctx = {
    message: { photo: [{ file_id: 'id3', file_unique_id: 'u', width: 1, height: 1, file_size: 1 }] },
    from: { id: 101 },
    reply: async (msg, opts) => replies.push({ msg, opts }),
    telegram: { getFileLink: async () => ({ href: 'http://file' }) },
  };
  process.env.FREE_PHOTO_LIMIT = '4';
  await withMockFetch({
    'http://file': { arrayBuffer: async () => Buffer.from('x') },
    default: { status: 402, json: async () => ({ error: 'limit_reached', limit: 5 }) },
  }, async () => {
    await photoHandler(pool, ctx);
  });
  assert.equal(replies[0].msg, 'Бесплатный лимит 4 фото/мес исчерпан');
  const btns = replies[0].opts.reply_markup.inline_keyboard[0];
  assert.equal(btns[0].url, 'https://t.me/YourBot?start=paywall');
  assert.equal(btns[1].url, 'https://t.me/YourBot?start=faq');
});

test('subscribeHandler shows paywall', async () => {
  const replies = [];
  const ctx = { reply: async (msg, opts) => replies.push({ msg, opts }) };
  process.env.FREE_PHOTO_LIMIT = '5';
  await subscribeHandler(ctx);
  assert.equal(replies[0].msg, 'Бесплатный лимит 5 фото/мес исчерпан');
  const btns = replies[0].opts.reply_markup.inline_keyboard[0];
  assert.equal(btns[0].url, 'https://t.me/YourBot?start=paywall');
  assert.equal(btns[1].url, 'https://t.me/YourBot?start=faq');
});
