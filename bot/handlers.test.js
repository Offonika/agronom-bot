const assert = require('node:assert/strict');
const { test } = require('node:test');

process.env.FREE_PHOTO_LIMIT = '5';
const {
  photoHandler,
  messageHandler,
  subscribeHandler,
  startHandler,
  buyProHandler,
  pollPaymentStatus,
  retryHandler,
} = require('./handlers');

async function withMockFetch(responses, fn) {
  const origFetch = global.fetch;
  global.fetch = async (url) => {
    if (Object.prototype.hasOwnProperty.call(responses, url)) {
      return { ok: true, ...responses[url] };
    }
    if (responses.default) {
      return { ok: true, ...responses.default };
    }
    throw new Error(`Unexpected fetch ${url}`);
  };
  try {
    await fn();
  } finally {
    global.fetch = origFetch;
  }
}

test('photoHandler stores info and replies', { concurrency: false }, async () => {
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

test('messageHandler ignores non-photo', { concurrency: false }, () => {
  let logged = '';
  const orig = console.log;
  console.log = (msg) => { logged = msg; };
  messageHandler({ message: { text: 'hi' } });
  console.log = orig;
  assert.equal(logged, 'Ignoring non-photo message');
});

test('photoHandler sends protocol buttons', { concurrency: false }, async () => {
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

test('photoHandler beta without protocol', { concurrency: false }, async () => {
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

test('photoHandler paywall on 402', { concurrency: false }, async () => {
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
  assert.equal(btns[0].callback_data, 'buy_pro');
  assert.equal(btns[1].url, 'https://t.me/YourBot?start=faq');
});

test('subscribeHandler shows paywall', { concurrency: false }, async () => {
  const replies = [];
  const ctx = { reply: async (msg, opts) => replies.push({ msg, opts }) };
  process.env.FREE_PHOTO_LIMIT = '5';
  await subscribeHandler(ctx);
  assert.equal(replies[0].msg, 'Бесплатный лимит 5 фото/мес исчерпан');
  const btns = replies[0].opts.reply_markup.inline_keyboard[0];
  assert.equal(btns[0].callback_data, 'buy_pro');
  assert.equal(btns[1].url, 'https://t.me/YourBot?start=faq');
});

test('subscribeHandler logs paywall_shown', { concurrency: false }, async () => {
  const events = [];
  const pool = { query: async (...a) => events.push(a) };
  const ctx = { from: { id: 7 }, reply: async () => {} };
  await subscribeHandler(ctx, pool);
  assert.equal(events.length, 1);
  assert.equal(events[0][0], 'INSERT INTO events (user_id, event) VALUES ($1, $2)');
  assert.deepEqual(events[0][1], [7, 'paywall_shown']);
});

test('startHandler logs paywall clicks', { concurrency: false }, async () => {
  const events = [];
  const pool = { query: async (...a) => events.push(a) };
  await startHandler({ startPayload: 'paywall', from: { id: 8 }, reply: async () => {} }, pool);
  await startHandler({ startPayload: 'faq', from: { id: 9 }, reply: async () => {} }, pool);
  assert.deepEqual(events, [
    ['INSERT INTO events (user_id, event) VALUES ($1, $2)', [8, 'paywall_click_buy']],
    ['INSERT INTO events (user_id, event) VALUES ($1, $2)', [9, 'paywall_click_faq']],
  ]);
});

test('buyProHandler returns payment link', { concurrency: false }, async () => {
  const replies = [];
  const ctx = { from: { id: 1 }, answerCbQuery: () => {}, reply: async (msg, opts) => replies.push({ msg, opts }) };
  const pool = { query: async () => {} };
  await withMockFetch({
    'http://localhost:8000/v1/payments/create': { json: async () => ({ url: 'http://pay', payment_id: 'p1' }) },
    default: { json: async () => ({ status: 'success', pro_expires_at: '2025-01-01T00:00:00Z' }) },
  }, async () => {
    await buyProHandler(ctx, pool, 0);
    if (ctx.pollPromise) await ctx.pollPromise;
    await new Promise(r => setTimeout(r, 20));
  });
  const btn = replies[0].opts.reply_markup.inline_keyboard[0][0];
  assert.equal(btn.url, 'http://pay');
  assert.equal(btn.text, 'Оплатить 199 ₽ через СБП');
  assert.equal(ctx.paymentId, 'p1');
});

test('buyProHandler polls success', { concurrency: false }, async () => {
  const replies = [];
  const ctx = { from: { id: 2 }, answerCbQuery: () => {}, reply: async (msg, opts) => replies.push({ msg, opts }) };
  const pool = { query: async () => {} };
  await withMockFetch({
    'http://localhost:8000/v1/payments/create': { json: async () => ({ url: 'http://pay', payment_id: 'p2' }) },
    'http://localhost:8000/v1/payments/p2': { json: async () => ({ status: 'success', pro_expires_at: '2025-12-31T00:00:00Z' }) },
    default: { json: async () => ({ status: 'pending' }) },
  }, async () => {
    await buyProHandler(ctx, pool, 1);
    if (ctx.pollPromise) await ctx.pollPromise;
  });
  assert.ok(replies[1].msg.startsWith('Оплата прошла'));
});

test('buyProHandler polls fail', { concurrency: false }, async () => {
  const replies = [];
  const ctx = { from: { id: 3 }, answerCbQuery: () => {}, reply: async (msg, opts) => replies.push({ msg, opts }) };
  const pool = { query: async () => {} };
  await withMockFetch({
    'http://localhost:8000/v1/payments/create': { json: async () => ({ url: 'http://pay', payment_id: 'p3' }) },
    'http://localhost:8000/v1/payments/p3': { json: async () => ({ status: 'fail' }) },
    default: { json: async () => ({ status: 'fail' }) },
  }, async () => {
    await buyProHandler(ctx, pool, 1);
    if (ctx.pollPromise) await ctx.pollPromise;
  });
  assert.equal(replies[1].msg, 'Оплата не удалась ❌');
});

test('paywall disabled does not reply', { concurrency: false }, async () => {
  process.env.PAYWALL_ENABLED = 'false';
  const replies = [];
  const ctx = { reply: async (msg, opts) => replies.push({ msg, opts }) };
  await subscribeHandler(ctx);
  assert.equal(replies.length, 0);
  delete process.env.PAYWALL_ENABLED;
});

test('photoHandler pending reply', { concurrency: false }, async () => {
  const pool = { query: async () => {} };
  const replies = [];
  const ctx = {
    message: { photo: [{ file_id: 'id5', file_unique_id: 'u', width: 1, height: 1, file_size: 1 }] },
    from: { id: 200 },
    reply: async (msg, opts) => replies.push({ msg, opts }),
    telegram: { getFileLink: async () => ({ href: 'http://file' }) },
  };
  await withMockFetch({
    'http://file': { arrayBuffer: async () => Buffer.from('x') },
    default: { status: 202, json: async () => ({ status: 'pending', id: 42 }) },
  }, async () => {
    await photoHandler(pool, ctx);
  });
  assert.equal(replies[0].msg, 'Диагностика в процессе обработки. Результат будет позже');
  const btn = replies[0].opts.reply_markup.inline_keyboard[0][0];
  assert.equal(btn.text, '🔄 Проверить позже');
  assert.equal(btn.callback_data, 'retry|42');
});

test('retryHandler returns result', { concurrency: false }, async () => {
  const replies = [];
  const ctx = { from: { id: 1 }, reply: async (msg, opts) => replies.push({ msg, opts }) };
  await withMockFetch({
    'http://localhost:8000/v1/photos/42': {
      json: async () => ({
        status: 'ok',
        crop: 'apple',
        disease: 'scab',
        confidence: 0.95,
      }),
    },
  }, async () => {
    await retryHandler(ctx, 42);
  });
  assert.ok(replies[0].msg.includes('Культура: apple'));
});
