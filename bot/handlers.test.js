const assert = require('node:assert/strict');
const { test } = require('node:test');

process.env.FREE_PHOTO_LIMIT = '5';
const {
  formatDiagnosis,
  photoHandler,
  messageHandler,
  retryHandler,
} = require('./diagnosis');
const {
  subscribeHandler,
  buyProHandler,
  pollPaymentStatus,
} = require('./payments');
const { startHandler, helpHandler, feedbackHandler } = require('./commands');
const { historyHandler } = require('./history');
const strings = require('../locales/ru.json');
const { msg } = require('./utils');
function tr(key, vars = {}) {
  let text = strings[key];
  for (const [k, v] of Object.entries(vars)) {
    text = text.replace(`{${k}}`, v);
  }
  return text;
}

async function withMockFetch(responses, fn, calls) {
  const origFetch = global.fetch;
  const open = [];
  global.fetch = async (url, opts = {}) => {
    if (calls) calls.push({ url, opts });
    let resp;
    if (Object.prototype.hasOwnProperty.call(responses, url)) {
      resp = responses[url];
    } else if (responses.default) {
      resp = responses.default;
    } else {
      throw new Error(`Unexpected fetch ${url}`);
    }
    if (resp.body && typeof resp.body.destroy === 'function') {
      open.push(resp.body);
    }
    return { ok: true, ...resp };
  };
  try {
    await fn();
  } finally {
    global.fetch = origFetch;
    for (const b of open) {
      try {
        b.destroy();
      } catch {
        // ignore
      }
    }
  }
}

test('photoHandler stores info and replies', { concurrency: false }, async () => {
  process.env.BETA_EXPERT_CHAT = 'true';
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
  delete process.env.BETA_EXPERT_CHAT;
});

test('photoHandler handles non-ok API status', { concurrency: false }, async () => {
  const pool = { query: async () => {} };
  const replies = [];
  const ctx = {
    message: { photo: [{ file_id: 'id1', file_unique_id: 'u', width: 1, height: 1, file_size: 1 }] },
    from: { id: 1 },
    reply: async (msg) => replies.push(msg),
    telegram: { getFileLink: async () => ({ href: 'http://file' }) },
  };
  await withMockFetch({
    'http://file': { arrayBuffer: async () => Buffer.from('x') },
    default: { ok: false, status: 500 },
  }, async () => {
    await photoHandler(pool, ctx);
  });
  assert.equal(replies[0], msg('diagnose_error'));
});

test('photoHandler handles invalid JSON response', { concurrency: false }, async () => {
  const pool = { query: async () => {} };
  const replies = [];
  const ctx = {
    message: { photo: [{ file_id: 'id1', file_unique_id: 'u', width: 1, height: 1, file_size: 1 }] },
    from: { id: 1 },
    reply: async (msg) => replies.push(msg),
    telegram: { getFileLink: async () => ({ href: 'http://file' }) },
  };
  await withMockFetch({
    'http://file': { arrayBuffer: async () => Buffer.from('x') },
    default: { json: async () => { throw new Error('bad json'); } },
  }, async () => {
    await photoHandler(pool, ctx);
  });
  assert.equal(replies[0], msg('diagnose_error'));
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
  assert.equal(
    buttons[0].callback_data,
    'proto|%D0%A1%D0%BA%D0%BE%D1%80%20250%20%D0%AD%D0%9A|2|ml_10l|30'
  );
  assert.ok(buttons[1].url.includes('pid=1'));
});

test('formatDiagnosis encodes special characters in callback_data', () => {
  const ctx = { from: { id: 1 } };
  const data = {
    crop: 'c',
    disease: 'd',
    confidence: 0.9,
    protocol: {
      product: 'аб / в',
      dosage_value: 1,
      dosage_unit: 'ml',
      phi: 10,
    },
  };
  const { keyboard } = formatDiagnosis(ctx, data);
  const cb = keyboard.inline_keyboard[0][0].callback_data;
  assert.ok(cb.includes('%2F'));
  assert.ok(cb.includes('%20'));
});

test('formatDiagnosis trims long product names and limits callback_data', () => {
  const ctx = { from: { id: 1 } };
  const longName = 'A'.repeat(120);
  const data = {
    crop: 'c',
    disease: 'd',
    confidence: 0.9,
    protocol: {
      product: longName,
      dosage_value: 1,
      dosage_unit: 'ml',
      phi: 10,
    },
  };
  const { keyboard } = formatDiagnosis(ctx, data);
  const cb = keyboard.inline_keyboard[0][0].callback_data;
  assert.ok(cb.length <= 64);
  assert.ok(!cb.includes('AAAAAA'));
});

test('photoHandler shows expert button when enabled', { concurrency: false }, async () => {
  process.env.BETA_EXPERT_CHAT = 'true';
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
  assert.equal(button.text, 'Спросить эксперта');
  delete process.env.BETA_EXPERT_CHAT;
});

test('photoHandler hides expert button when disabled', { concurrency: false }, async () => {
  const pool = { query: async () => {} };
  const replies = [];
  const ctx = {
    message: { photo: [{ file_id: 'id22', file_unique_id: 'u', width: 1, height: 1, file_size: 1 }] },
    from: { id: 101 },
    reply: async (msg, opts) => replies.push({ msg, opts }),
    telegram: { getFileLink: async () => ({ href: 'http://file' }) },
  };
  await withMockFetch({
    'http://file': { arrayBuffer: async () => Buffer.from('x') },
    default: { json: async () => ({ crop: 'apple', disease: 'scab', confidence: 0.9 }) },
  }, async () => {
    await photoHandler(pool, ctx);
  });
  assert.equal(replies[0].opts.reply_markup, undefined);
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
  assert.equal(replies[0].msg, tr('paywall', { limit: 4 }));
  const btns = replies[0].opts.reply_markup.inline_keyboard[0];
  assert.equal(btns[0].callback_data, 'buy_pro');
  assert.equal(btns[1].url, 'https://t.me/YourBot?start=faq');
});

test('subscribeHandler shows paywall', { concurrency: false }, async () => {
  const replies = [];
  const ctx = { reply: async (msg, opts) => replies.push({ msg, opts }) };
  process.env.FREE_PHOTO_LIMIT = '5';
  await subscribeHandler(ctx);
  assert.equal(replies[0].msg, tr('paywall', { limit: 5 }));
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

test('startHandler replies with onboarding text', { concurrency: false }, async () => {
  let msg = '';
  const ctx = { reply: async (m) => { msg = m; }, startPayload: undefined, from: { id: 1 } };
  await startHandler(ctx, { query: async () => {} });
  assert.equal(msg, tr('start'));
});

test('buyProHandler returns payment link', { concurrency: false }, async () => {
  const replies = [];
  const ctx = { from: { id: 1 }, answerCbQuery: () => {}, reply: async (msg, opts) => replies.push({ msg, opts }) };
  const pool = { query: async () => {} };
  const calls = [];
  await withMockFetch(
    {
      'http://localhost:8000/v1/payments/create': { json: async () => ({ url: 'http://pay', payment_id: 'p1' }) },
      default: { json: async () => ({ status: 'success', pro_expires_at: '2025-01-01T00:00:00Z' }) },
    },
    async () => {
      await buyProHandler(ctx, pool, 0);
      if (ctx.pollPromise) await ctx.pollPromise;
    },
    calls,
  );
  const btn = replies[0].opts.reply_markup.inline_keyboard[0][0];
  assert.equal(btn.url, 'http://pay');
  assert.equal(btn.text, tr('payment_button'));
  assert.equal(ctx.paymentId, 'p1');
  const req = calls.find((c) => c.url === 'http://localhost:8000/v1/payments/create');
  assert.equal(req.opts.method, 'POST');
  assert.equal(req.opts.headers['Content-Type'], 'application/json');
  assert.equal(req.opts.headers['X-API-Key'], 'test-api-key');
  assert.equal(req.opts.headers['X-API-Ver'], 'v1');
  assert.equal(req.opts.headers['X-User-ID'], 1);
  assert.deepEqual(JSON.parse(req.opts.body), { user_id: 1, plan: 'pro', months: 1 });
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
  assert.equal(replies[1].msg, tr('payment_fail'));
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
  assert.equal(replies[0].msg, tr('diag_pending'));
  const btn = replies[0].opts.reply_markup.inline_keyboard[0][0];
  assert.equal(btn.text, tr('retry_button'));
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

test('historyHandler paginates', { concurrency: false }, async () => {
  const replies = [];
  const events = [];
  const calls = [];
  const pool = { query: async (...a) => events.push(a) };
  const ctx = { from: { id: 1 }, reply: async (msg, opts) => replies.push({ msg, opts }) };
  await withMockFetch(
    {
      'http://localhost:8000/v1/photos/history?limit=10&offset=0': {
        json: async () => [
          { photo_id: 1, ts: '2025-01-01T00:00:00Z', crop: 'apple', disease: 'scab', status: 'ok' },
        ],
      },
    },
    async () => {
      await historyHandler(ctx, 0, pool);
    },
    calls,
  );
  assert.ok(replies[0].msg.includes('1.'));
  const kb = replies[0].opts.reply_markup.inline_keyboard;
  assert.equal(kb[0][0].callback_data, 'info|1');
  assert.equal(kb[kb.length - 1][1].callback_data, 'history|10');
  assert.equal(events[0][1][1], 'history_open');
  assert.equal(events[1][1][1], 'history_page_0');
  assert.equal(calls[0].opts.headers['X-User-ID'], 1);
});

test('historyHandler logs page event', { concurrency: false }, async () => {
  const events = [];
  const pool = { query: async (...a) => events.push(a) };
  const ctx = { from: { id: 2 }, reply: async () => {} };
  await withMockFetch({
    'http://localhost:8000/v1/photos/history?limit=10&offset=10': { json: async () => [] },
  }, async () => {
    await historyHandler(ctx, 10, pool);
  });
  assert.equal(events[0][1][1], 'history_page_10');
});

test('historyHandler handles malformed responses', { concurrency: false }, async () => {
  for (const bad of [{ bad: 'data' }, 'oops']) {
    const replies = [];
    let logged = '';
    const ctx = { from: { id: 1 }, reply: async (msg) => replies.push(msg) };
    const origErr = console.error;
    console.error = (...args) => {
      logged = args.join(' ');
    };
    await withMockFetch(
      {
        'http://localhost:8000/v1/photos/history?limit=10&offset=0': { json: async () => bad },
      },
      async () => {
        await historyHandler(ctx, 0);
      },
    );
    console.error = origErr;
    assert.equal(replies[0], msg('history_error'));
    assert.ok(logged.includes('Unexpected history response'));
  }
});

test('historyHandler returns early without user', { concurrency: false }, async () => {
  const replies = [];
  const calls = [];
  const ctx = { reply: async (msg) => replies.push(msg) };
  await withMockFetch({}, async () => {
    await historyHandler(ctx);
  }, calls);
  assert.equal(replies[0], msg('history_error'));
  assert.equal(calls.length, 0);
});

test('helpHandler returns links', { concurrency: false }, async () => {
  process.env.PRIVACY_URL = 'https://example.com/policy';
  process.env.OFFER_URL = 'https://example.com/offer';
  const replies = [];
  const ctx = { reply: async (msg, opts) => replies.push({ msg, opts }) };
  await helpHandler(ctx);
  assert.ok(replies[0].msg.includes('example.com/policy'));
  assert.ok(replies[0].msg.includes('example.com/offer'));
  const buttons = replies[0].opts.reply_markup.inline_keyboard;
  assert.equal(buttons[0][0].url, 'https://example.com/policy');
  assert.equal(buttons[1][0].url, 'https://example.com/offer');
  assert.equal(buttons[0][0].text, tr('privacy_button'));
  assert.equal(buttons[1][0].text, tr('offer_button'));
});

test('feedbackHandler sends link and logs event', { concurrency: false }, async () => {
  const replies = [];
  const events = [];
  const pool = { query: async (...a) => events.push(a) };
  const ctx = { from: { id: 77 }, reply: async (msg, opts) => replies.push({ msg, opts }) };
  process.env.FEEDBACK_URL = 'https://fb.example/form';
  await feedbackHandler(ctx, pool);
  const btn = replies[0].opts.reply_markup.inline_keyboard[0][0];
  assert.ok(btn.url.startsWith('https://fb.example/form'));
  assert.ok(btn.url.includes('utm_source=telegram'));
  assert.equal(events[0][1][1], 'feedback_open');
  delete process.env.FEEDBACK_URL;
});

test('formatDiagnosis builds reply with protocol', () => {
  const ctx = { from: { id: 1 } };
  const data = {
    crop: 'apple',
    disease: 'scab',
    confidence: 0.9,
    protocol: {
      id: 10,
      product: 'Хорус',
      dosage_value: 2,
      dosage_unit: 'ml_10l',
      phi: 15,
    },
  };
  const { text, keyboard } = formatDiagnosis(ctx, data);
  assert.ok(text.includes('Культура: apple'));
  const btns = keyboard.inline_keyboard[0];
  assert.equal(
    btns[0].callback_data,
    'proto|%D0%A5%D0%BE%D1%80%D1%83%D1%81|2|ml_10l|15'
  );
  assert.ok(btns[1].url.includes('pid=10'));
});

test('formatDiagnosis builds reply without protocol when enabled', () => {
  process.env.BETA_EXPERT_CHAT = 'true';
  const ctx = { from: { id: 2 } };
  const data = { crop: 'pear', disease: 'rot', confidence: 0.8 };
  const { text, keyboard } = formatDiagnosis(ctx, data);
  assert.ok(text.includes('Культура: pear'));
  const btn = keyboard.inline_keyboard[0][0];
  assert.equal(btn.text, 'Спросить эксперта');
  assert.equal(btn.callback_data, 'ask_expert');
  delete process.env.BETA_EXPERT_CHAT;
});

test('formatDiagnosis omits button when disabled', () => {
  const ctx = { from: { id: 3 } };
  const data = { crop: 'pear', disease: 'rot', confidence: 0.8 };
  const { text, keyboard } = formatDiagnosis(ctx, data);
  assert.ok(text.includes('Культура: pear'));
  assert.equal(keyboard, undefined);
});

test('msg replaces multiple occurrences of a variable', () => {
  strings.repeat = '{word} and {word}';
  const result = msg('repeat', { word: 'hi' });
  assert.equal(result, 'hi and hi');
  delete strings.repeat;
});

test('pollPaymentStatus notifies on timeout', { concurrency: false }, async () => {
  const replies = [];
  const ctx = { from: { id: 1 }, reply: async (m) => replies.push(m) };
  await withMockFetch(
    {
      'http://localhost:8000/v1/payments/42': { json: async () => ({ status: 'processing' }) },
    },
    async () => {
      await pollPaymentStatus(ctx, 42, 1, 5);
    },
  );
  assert.equal(replies[0], msg('payment_pending'));
});
