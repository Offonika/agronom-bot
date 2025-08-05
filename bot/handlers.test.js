const assert = require('node:assert/strict');
const { test } = require('node:test');

process.env.FREE_PHOTO_LIMIT = '5';
const {
  formatDiagnosis,
  photoHandler,
  messageHandler,
  retryHandler,
  getProductName,
} = require('./diagnosis');
const {
  subscribeHandler,
  buyProHandler,
  pollPaymentStatus,
  cancelAutopay,
  getLimit,
} = require('./payments');
const { startHandler, helpHandler, feedbackHandler } = require('./commands');
const { historyHandler } = require('./history');
const { reminderHandler, reminders } = require('./reminder');
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

test('photoHandler responds with error_code message', { concurrency: false }, async () => {
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
    default: { ok: false, status: 400, json: async () => ({ error_code: 'NO_LEAF' }) },
  }, async () => {
    await photoHandler(pool, ctx);
  });
  assert.equal(replies[0], msg('error_NO_LEAF'));
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

test('formatDiagnosis keeps original product name for callback', () => {
  const ctx = { from: { id: 1 } };
  const longName = 'B'.repeat(40);
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
  const [, prod] = cb.split('|');
  const decoded = decodeURIComponent(prod);
  assert.equal(getProductName(decoded), longName);
});

test('getProductName does not clean cache on read', { concurrency: false }, () => {
  delete require.cache[require.resolve('./diagnosis')];
  const { formatDiagnosis, getProductName } = require('./diagnosis');
  const ctx = { from: { id: 1 } };
  let firstHash;
  let lastHash;
  for (let i = 0; i < 100; i++) {
    const data = {
      crop: 'c',
      disease: 'd',
      confidence: 0.9,
      protocol: {
        product: `p${i}`,
        dosage_value: 1,
        dosage_unit: 'ml',
        phi: 10,
      },
    };
    const { keyboard } = formatDiagnosis(ctx, data);
    const [, hash] = keyboard.inline_keyboard[0][0].callback_data.split('|');
    const decoded = decodeURIComponent(hash);
    if (i === 0) firstHash = decoded;
    if (i === 99) lastHash = decoded;
  }
  assert.equal(getProductName(lastHash), 'p99');
  assert.equal(getProductName(firstHash), 'p0');
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
  assert.equal(replies[0].opts, undefined);
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

test('startHandler replies with FAQ', { concurrency: false }, async () => {
  const replies = [];
  const ctx = { startPayload: 'faq', from: { id: 2 }, reply: async (m, opts) => replies.push({ msg: m, opts }) };
  await startHandler(ctx, { query: async () => {} });
  assert.equal(replies[0].msg, tr('faq'));
  const btns = replies[0].opts.reply_markup.inline_keyboard[0];
  assert.equal(btns[0].callback_data, 'buy_pro');
  assert.equal(btns[0].text, tr('faq_buy_button'));
  assert.equal(btns[1].text, tr('faq_back_button'));
});

test('getLimit falls back to default for invalid env', () => {
  const orig = process.env.FREE_PHOTO_LIMIT;
  process.env.FREE_PHOTO_LIMIT = 'abc';
  assert.equal(getLimit(), 5);
  process.env.FREE_PHOTO_LIMIT = orig;
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
    assert.deepEqual(JSON.parse(req.opts.body), {
      user_id: 1,
      plan: 'pro',
      months: 1,
      autopay: false,
    });
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

test('buyProHandler handles non-ok API status', { concurrency: false }, async () => {
  const replies = [];
  const ctx = { from: { id: 6 }, answerCbQuery: () => {}, reply: async (msg, opts) => replies.push({ msg, opts }) };
  const pool = { query: async () => {} };
  await withMockFetch(
    {
      'http://localhost:8000/v1/payments/create': { ok: false, status: 500 },
    },
    async () => {
      await buyProHandler(ctx, pool, 0);
    },
  );
  assert.equal(replies[0].msg, msg('payment_error'));
});

test('buyProHandler sends autopay flag', { concurrency: false }, async () => {
  const replies = [];
  const ctx = {
    from: { id: 4 },
    answerCbQuery: () => {},
    reply: async (msg, opts) => replies.push({ msg, opts }),
  };
  const pool = { query: async () => {} };
  const calls = [];
  await withMockFetch(
    {
      'http://localhost:8000/v1/payments/create': {
        json: async () => ({ url: 'http://pay', payment_id: 'p4' }),
      },
      default: {
        json: async () => ({ status: 'success', pro_expires_at: '2025-01-01T00:00:00Z' }),
      },
    },
    async () => {
      await buyProHandler(ctx, pool, 0, 60000, true);
    },
    calls,
  );
  const req = calls.find((c) => c.url === 'http://localhost:8000/v1/payments/create');
  assert.equal(JSON.parse(req.opts.body).autopay, true);
});

test('cancelAutopay calls API with auth tokens', { concurrency: false }, async () => {
  const replies = [];
  const ctx = { from: { id: 5 }, reply: async (m) => replies.push(m) };
  const calls = [];
  await withMockFetch(
    {
      'http://localhost:8000/v1/auth/token': { json: async () => ({ jwt: 'j', csrf: 'c' }) },
      'http://localhost:8000/v1/payments/sbp/autopay/cancel': { status: 204 },
    },
    async () => {
      await cancelAutopay(ctx);
    },
    calls,
  );
  const cancelReq = calls.find((c) => c.url.endsWith('/autopay/cancel'));
  assert.equal(cancelReq.opts.headers.Authorization, 'Bearer j');
  assert.equal(cancelReq.opts.headers['X-CSRF-Token'], 'c');
  assert.equal(JSON.parse(cancelReq.opts.body).user_id, 5);
  assert.equal(replies[0], tr('autopay_cancel_success'));
});

test('cancelAutopay handles unauthorized', { concurrency: false }, async () => {
  const replies = [];
  const ctx = { from: { id: 6 }, reply: async (m) => replies.push(m) };
  await withMockFetch(
    {
      'http://localhost:8000/v1/auth/token': { json: async () => ({ jwt: 'j', csrf: 'c' }) },
      'http://localhost:8000/v1/payments/sbp/autopay/cancel': { status: 401 },
    },
    async () => {
      await cancelAutopay(ctx);
    },
  );
  assert.equal(replies[0], tr('error_UNAUTHORIZED'));
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
  assert.equal(replies[0].opts, undefined);
});

test('historyHandler paginates', { concurrency: false }, async () => {
  const replies = [];
  const events = [];
  const calls = [];
  const pool = { query: async (...a) => events.push(a) };
  const ctx = { from: { id: 1 }, reply: async (msg, opts) => replies.push({ msg, opts }) };
  await withMockFetch(
    {
      'http://localhost:8000/v1/photos?limit=10': {
        json: async () => ({
          items: [
            { id: 1, ts: '2025-01-01T00:00:00Z', crop: 'apple', disease: 'scab' },
          ],
          next_cursor: 'abc',
        }),
      },
    },
    async () => {
      await historyHandler(ctx, '', pool);
    },
    calls,
  );
  assert.ok(replies[0].msg.includes('1.'));
  const kb = replies[0].opts.reply_markup.inline_keyboard;
  assert.equal(kb[0][0].callback_data, 'info|1');
  assert.equal(kb[kb.length - 1][0].callback_data, 'history|abc');
  assert.equal(events[0][1][1], 'history_open');
  assert.equal(events[1][1][1], 'history_page_0');
  assert.equal(calls[0].opts.headers['X-User-ID'], 1);
});

test('historyHandler logs page event', { concurrency: false }, async () => {
  const events = [];
  const pool = { query: async (...a) => events.push(a) };
  const ctx = { from: { id: 2 }, reply: async () => {} };
  await withMockFetch({
    'http://localhost:8000/v1/photos?limit=10&cursor=abc': { json: async () => ({ items: [], next_cursor: null }) },
  }, async () => {
    await historyHandler(ctx, 'abc', pool);
  });
  assert.equal(events[0][1][1], 'history_page_abc');
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
        'http://localhost:8000/v1/photos?limit=10': { json: async () => bad },
      },
      async () => {
        await historyHandler(ctx, '');
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

test('pollPaymentStatus stops when aborted', { concurrency: false }, async () => {
  const replies = [];
  const ctx = { from: { id: 1 }, reply: async (m) => replies.push(m) };
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 2);
  await withMockFetch(
    {
      'http://localhost:8000/v1/payments/42': { json: async () => ({ status: 'processing' }) },
    },
    async () => {
      await pollPaymentStatus(ctx, 42, 10, 100, controller.signal);
    },
  );
  assert.equal(replies.length, 0);
});

test('buyProHandler aborts existing poll', { concurrency: false }, async () => {
  const ctx = {
    from: { id: 1 },
    answerCbQuery: async () => {},
    reply: async () => {},
  };
  const pool = { query: async () => {} };
  await withMockFetch(
    {
      'http://localhost:8000/v1/payments/create': {
        json: async () => ({ payment_id: 1, url: 'http://pay' }),
      },
      'http://localhost:8000/v1/payments/1': {
        json: async () => ({ status: 'success', pro_expires_at: new Date().toISOString() }),
      },
    },
    async () => {
      await buyProHandler(ctx, pool, 50, 200);
      const oldPromise = ctx.pollPromise;
      const oldController = ctx.pollController;
      await buyProHandler(ctx, pool, 50, 200);
      assert.ok(oldController.signal.aborted);
      await oldPromise;
      await ctx.pollPromise;
      assert.equal(ctx.pollPromise, null);
    },
  );
});

test('reminderHandler creates reminder', { concurrency: false }, async () => {
  const replies = [];
  const ctx = {
    from: { id: 7 },
    callbackQuery: { data: 'remind_add' },
    answerCbQuery: async () => {},
    reply: async (m, o) => replies.push({ m, o }),
  };
  await reminderHandler(ctx);
  assert.equal(replies[0].m, msg('reminder_created'));
  assert.equal(reminders.get(7).length, 1);
  reminders.clear();
});

test('reminderHandler cancels reminder', { concurrency: false }, async () => {
  const t = setTimeout(() => {}, 0);
  t.unref();
  reminders.set(8, [{ id: 1, timeout: t }]);
  const replies = [];
  const ctx = {
    from: { id: 8 },
    callbackQuery: { data: 'remind_cancel|1' },
    answerCbQuery: async () => {},
    reply: async (m) => replies.push(m),
  };
  await reminderHandler(ctx);
  assert.equal(replies[0], msg('reminder_cancelled'));
  assert.equal(reminders.get(8).length, 0);
  reminders.clear();
});
