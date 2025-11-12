const assert = require('node:assert/strict');
const { test } = require('node:test');
const { Readable } = require('node:stream');

process.env.FREE_PHOTO_LIMIT = '5';

process.env.API_BASE_URL = 'http://localhost:8010';

const API_BASE = process.env.API_BASE_URL;
const PAYMENTS_BASE = `${API_BASE}/v1/payments`;
const {
  photoHandler,
  messageHandler,
  retryHandler,
  getProductName,
  rememberDiagnosis,
  getCropHint,
  handleClarifySelection,
  buildProtocolRow,
} = require('./diagnosis');
const { createPlanPickHandler } = require('./callbacks/plan_pick');
const { createPlanTriggerHandler } = require('./callbacks/plan_trigger');
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
const { createPlanCommands } = require('./planCommands');
const { createReminderScheduler } = require('./reminders');
const { createPlanFlow } = require('./planFlow');
const {
  buildAssistantText,
  buildKeyboardLayout,
  resolveFollowupReply,
} = require('./messageFormatters/diagnosisMessage');
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
    const clone = { ...resp };
    if (!Object.prototype.hasOwnProperty.call(clone, 'ok')) {
      clone.ok = true;
    }
    if (typeof clone.json === 'function') {
      const originalJson = clone.json.bind(clone);
      let cached;
      clone.json = async () => {
        if (cached !== undefined) return cached;
        cached = await originalJson();
        return cached;
      };
      if (typeof clone.text !== 'function') {
        clone.text = async () => JSON.stringify(await clone.json());
      }
    } else {
      clone.json = async () => ({});
      if (typeof clone.text !== 'function') {
        clone.text = async () => '{}';
      }
    }
    return clone;
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
  const calls = [];
  const planFlowCalls = [];
  const deps = {
    pool: { query: async (...args) => { calls.push(args); } },
    planFlow: {
      start: async (ctx, data) => {
        planFlowCalls.push({ ctx, data });
      },
    },
  };
  const replies = [];
  const ctx = {
    message: { photo: [{ file_id: 'id1', file_unique_id: 'uid', width: 1, height: 2, file_size: 3 }] },
    from: { id: 42 },
    reply: async (msg, opts) => replies.push({ msg, opts }),
    telegram: { getFileLink: async () => ({ href: 'http://file' }) },
  };
  await withMockFetch({
    'http://file': { body: Readable.from(Buffer.from('x')) },
    default: {
      json: async () => ({
        crop: 'apple',
        disease: 'scab',
        confidence: 0.9,
        treatment_plan: {
          product: 'Топаз',
          dosage: '2 мл',
          phi: '30',
          safety: 'Перчатки',
        },
        next_steps: { reminder: 'Повторить', green_window: 'Вечер', cta: 'Добавить обработку' },
      }),
    },
  }, async () => {
    await photoHandler(deps, ctx);
  });
  assert.equal(calls.length, 1);
  assert.equal(planFlowCalls.length, 1);
  assert.equal(replies[0].msg, tr('photo_processing'));
  const diagnosisReply = replies[1];
  assert.ok(diagnosisReply.msg.includes('📸 Диагноз'));
  assert.ok(diagnosisReply.msg.includes('⏰ Что дальше'));
  const callbacks = diagnosisReply.opts.reply_markup.inline_keyboard.flat().map((btn) => btn.callback_data);
  assert.ok(callbacks.includes('plan_treatment'));
  assert.ok(callbacks.includes('phi_reminder'));
});

test('planPickHandler schedules treatment and phi reminders', async () => {
  const answers = [];
  const remindersCaptured = [];
  const eventsCaptured = [];
  const handler = createPlanPickHandler({
    db: {
      ensureUser: async () => ({ id: 5 }),
      selectStageOption: async () => ({
        stage: { id: 12, plan_id: 77, kind: 'season', phi_days: 7 },
        option: { id: 3 },
      }),
      createEvents: async (events) => {
        eventsCaptured.push(...events);
        return events.map((event, idx) => ({ ...event, id: idx + 1 }));
      },
      createReminders: async (rem) => remindersCaptured.push(...rem),
    },
  });
  const realNow = Date.now;
  Date.now = () => new Date('2025-01-01T00:00:00Z').getTime();
  try {
    await handler({
      from: { id: 42 },
      callbackQuery: { data: 'pick_opt|77|12|3' },
      answerCbQuery: async (text) => answers.push(text),
    });
  } finally {
    Date.now = realNow;
  }
  assert.equal(eventsCaptured.length, 2);
  assert.equal(remindersCaptured.length, 2);
  assert.equal(answers[0], msg('plan_saved_toast'));
});

test('planPickHandler skips scheduling for trigger stages', async () => {
  const answers = [];
  const handler = createPlanPickHandler({
    db: {
      ensureUser: async () => ({ id: 5 }),
      selectStageOption: async () => ({
        stage: { id: 12, plan_id: 77, kind: 'trigger', phi_days: null },
        option: { id: 3 },
      }),
      createEvents: async () => {
        throw new Error('should not be called');
      },
      createReminders: async () => {
        throw new Error('should not be called');
      },
    },
  });
  await handler({
    from: { id: 42 },
    callbackQuery: { data: 'pick_opt|77|12|3' },
    answerCbQuery: async (text) => answers.push(text),
  });
  assert.equal(answers[0], msg('plan_saved_wait_trigger'));
});

test('planFlow start prompts for object selection', async () => {
  const replies = [];
  const planFlow = createPlanFlow({
    db: {
      ensureUser: async () => ({ id: 9, last_object_id: null }),
      listObjects: async () => [],
      createObject: async () => ({ id: 1, name: 'Авто объект' }),
      updateUserLastObject: async () => {},
    },
    catalog: {
      suggestStages: async () => [],
      suggestOptions: async () => [],
    },
    planWizard: { showPlanTable: async () => {} },
  });
  await planFlow.start(
    {
      from: { id: 77 },
      chat: { id: 1 },
      reply: async (msg, opts) => replies.push({ msg, opts }),
    },
    { crop: 'apple', confidence: 0.9 },
  );
  assert.ok(replies[0].msg.includes('объекта'));
  assert.ok(replies[0].opts.reply_markup.inline_keyboard[0][0].callback_data.startsWith('plan_obj_confirm'));
});

test('planFlow confirm creates plan and renders table', async () => {
  const wizardCalls = [];
  const planFlow = createPlanFlow({
    db: {
      ensureUser: async () => ({ id: 12, last_object_id: null }),
      listObjects: async () => [{ id: 3, name: 'Грядка', user_id: 12 }],
      createObject: async () => ({ id: 3, name: 'Грядка', user_id: 12 }),
      updateUserLastObject: async () => {},
      getObjectById: async () => ({ id: 3, name: 'Грядка', user_id: 12, location_tag: null }),
      createCase: async () => ({ id: 21 }),
      createPlan: async () => ({ id: 31 }),
      createStagesWithOptions: async () => {},
    },
    catalog: {
      suggestStages: async () => [{ title: 'До цветения', kind: 'season', phi_days: 7, note: 'note', meta: {} }],
      suggestOptions: async () => [{ product: 'ХОМ', dose_value: 40, dose_unit: 'г/10л', meta: {} }],
    },
    planWizard: {
      showPlanTable: async (chatId, planId) => wizardCalls.push({ chatId, planId }),
    },
  });
  await planFlow.start(
    {
      from: { id: 12 },
      chat: { id: 55 },
      reply: async () => {},
    },
    { crop: 'apple', disease: 'scab', confidence: 0.9 },
  );
  await planFlow.confirm(
    {
      from: { id: 12 },
      chat: { id: 55 },
      answerCbQuery: async () => {},
      reply: async () => {},
    },
    3,
  );
  assert.equal(wizardCalls[0].planId, 31);
});

test('planTriggerHandler schedules events for trigger stage', async () => {
  const remindersSaved = [];
  const handler = createPlanTriggerHandler({
    db: {
      ensureUser: async () => ({ id: 6 }),
      getStageById: async () => ({ id: 8, plan_id: 2, user_id: 6, kind: 'trigger', phi_days: 2 }),
      createEvents: async (events) => events.map((event, idx) => ({ ...event, id: idx + 1 })),
      createReminders: async (rem) => remindersSaved.push(...rem),
    },
  });
  const answers = [];
  await handler({
    from: { id: 6 },
    callbackQuery: { data: 'plan_trigger|2|8' },
    answerCbQuery: async (text) => answers.push(text),
  });
  assert.ok(remindersSaved.length >= 1);
  assert.equal(answers[0], msg('plan_trigger_scheduled'));
});

test('planCommands handlePlan uses wizard', async () => {
  const replies = [];
  let wizardCalled = false;
  const planCommands = createPlanCommands({
    db: {
      ensureUser: async () => ({ id: 1, last_object_id: null }),
      listObjects: async () => [{ id: 2, name: 'Грядка' }],
      updateUserLastObject: async () => {},
      getObjectById: async () => null,
      listPlansByObject: async () => [],
      getPlanForUser: async () => ({ id: 5, title: 'План' }),
    },
    planWizard: {
      showPlanTable: async () => {
        wizardCalled = true;
      },
    },
  });
  await planCommands.handlePlan({
    from: { id: 42 },
    chat: { id: 42 },
    message: { text: '/plan 5' },
    reply: async (text) => replies.push(text),
  });
  assert.ok(wizardCalled);
  assert.ok(replies[0].includes('Показываю план'));
});

test('planCommands handleDone updates next event', async () => {
  const replies = [];
  let updated = null;
  const planCommands = createPlanCommands({
    db: {
      ensureUser: async () => ({ id: 1 }),
      listObjects: async () => [],
      getObjectById: async () => null,
      updateUserLastObject: async () => {},
      getNextScheduledEvent: async () => ({ id: 9, stage_title: 'До цветения', plan_title: 'План' }),
      updateEventStatus: async (id, status) => {
        updated = { id, status };
      },
    },
    planWizard: { showPlanTable: async () => {} },
  });
  await planCommands.handleDone({
    from: { id: 42 },
    reply: async (text) => replies.push(text),
  });
  assert.deepEqual(updated, { id: 9, status: 'done' });
  assert.ok(replies[0].includes('До цветения'));
});

test('reminder scheduler sends due reminders', async () => {
  const sentMessages = [];
  const scheduler = createReminderScheduler({
    bot: {
      telegram: {
        sendMessage: async (chatId, text) => sentMessages.push({ chatId, text }),
      },
    },
    db: {
      dueReminders: async () => [
        { id: 1, user_tg_id: 7, event_type: 'treatment', plan_title: 'План', stage_title: 'До цветения' },
      ],
      markReminderSent: async () => {},
    },
    intervalMs: 10,
  });
  await scheduler.tick();
  assert.equal(sentMessages.length, 1);
  assert.ok(sentMessages[0].text.includes('План'));
});

test('photoHandler replies on DB error', { concurrency: false }, async () => {
  const pool = { query: async () => { throw new Error('fail'); } };
  const replies = [];
  let called = false;
  const ctx = {
    message: { photo: [{ file_id: 'id1', file_unique_id: 'u', width: 1, height: 1, file_size: 1 }] },
    from: { id: 1 },
    reply: async (msg) => replies.push(msg),
    telegram: { getFileLink: async () => { called = true; } },
  };
  await photoHandler(pool, ctx);
  assert.equal(replies[0], msg('db_error'));
  assert.equal(called, false);
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
    'http://file': { body: Readable.from(Buffer.from('x')) },
    default: { ok: false, status: 500 },
  }, async () => {
    await photoHandler(pool, ctx);
  });
  assert.equal(replies[0], tr('photo_processing'));
  assert.equal(replies[1], msg('diagnose_error'));
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
    'http://file': { body: Readable.from(Buffer.from('x')) },
    default: { ok: false, status: 400, json: async () => ({ code: 'NO_LEAF' }) },
  }, async () => {
    await photoHandler(pool, ctx);
  });
  assert.equal(replies[0], tr('photo_processing'));
  assert.equal(replies[1], msg('error_NO_LEAF'));
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
    'http://file': { body: Readable.from(Buffer.from('x')) },
    default: { text: async () => '{invalid' },
  }, async () => {
    await photoHandler(pool, ctx);
  });
  assert.equal(replies[0], tr('photo_processing'));
  assert.equal(replies[1], msg('diagnosis.parse_error'));
});

test('photoHandler rejects oversized photo', { concurrency: false }, async () => {
  const calls = [];
  const pool = { query: async (...args) => { calls.push(args); } };
  const replies = [];
  let linkCalled = false;
  const ctx = {
    message: {
      photo: [{ file_id: 'id1', file_unique_id: 'u', width: 1, height: 1, file_size: 2 * 1024 * 1024 + 1 }],
    },
    from: { id: 1 },
    reply: async (msg) => replies.push(msg),
    telegram: {
      getFileLink: async () => {
        linkCalled = true;
        return { href: 'http://file' };
      },
    },
  };
  await photoHandler(pool, ctx);
  assert.equal(replies[0], msg('photo_too_large'));
  assert.equal(linkCalled, false);
  assert.equal(calls.length, 0);
});

test('messageHandler replies with default follow-up when no keyword', { concurrency: false }, async () => {
  const replies = [];
  rememberDiagnosis(501, {
    crop: 'apple',
    disease: 'scab',
    confidence: 0.8,
  });
  await messageHandler({ from: { id: 501 }, message: { text: 'Привет' }, reply: async (msg) => replies.push(msg) });
  assert.equal(replies[0], msg('followup_default'));
});

test('messageHandler answers FAQ intent when diagnosis cached', { concurrency: false }, async () => {
  const replies = [];
  const ctx = {
    from: { id: 77 },
    message: { text: 'Что это за болезнь простыми словами?' },
    reply: async (msg) => replies.push(msg),
  };
  rememberDiagnosis(77, {
    crop: 'виноград',
    disease: 'powdery_mildew',
    disease_name_ru: 'мучнистая роса',
    confidence: 0.9,
    reasoning: ['Белый налёт'],
    treatment_plan: {
      product: 'Скор',
      dosage: '2 мл',
      phi: '30',
      safety: 'Перчатки',
    },
  });
  await messageHandler(ctx);
  assert.ok(replies[0]?.length > 0);
});

test('messageHandler answers follow-up from history', { concurrency: false }, async () => {
  const replies = [];
  const ctx = {
    from: { id: 201 },
    message: { text: 'Курс лечения какой?' },
    reply: async (msg) => replies.push(msg),
  };
  rememberDiagnosis(201, { assistant_followups_ru: ['Курс лечения: повтор через 10 дней.'] });
  await messageHandler(ctx);
  assert.equal(replies[0], 'Курс лечения: повтор через 10 дней.');
});

test('messageHandler asks for new photo when no context', { concurrency: false }, async () => {
  const replies = [];
  const ctx = {
    from: { id: 88 },
    message: { text: 'От чего болезни?' },
    reply: async (msg) => replies.push(msg),
  };
  await messageHandler(ctx);
  assert.equal(replies[0], msg('faq.no_context'));
});

test('handleClarifySelection stores hint and confirms', { concurrency: false }, async () => {
  const replies = [];
  const ctx = {
    from: { id: 55 },
    reply: async (msg) => replies.push(msg),
    answerCbQuery: async () => {},
  };
  await handleClarifySelection(ctx, 'tomato');
  assert.equal(replies[0], msg('clarify.crop.confirm', { crop: strings.clarify.crop.options.tomato }));
  assert.equal(getCropHint(55), 'tomato');
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
    'http://file': { body: Readable.from(Buffer.from('x')) },
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
  assert.equal(replies[0].msg, tr('photo_processing'));
  const buttons = replies[1].opts.reply_markup.inline_keyboard[0];
  assert.equal(buttons[0].text, 'Показать протокол');
  assert.equal(
    buttons[0].callback_data,
    'proto|%D0%A1%D0%BA%D0%BE%D1%80%20250%20%D0%AD%D0%9A|2|ml_10l|30'
  );
  assert.ok(buttons[1].url.includes('pid=1'));
});

test('buildProtocolRow encodes special characters in callback_data', () => {
  const ctx = { from: { id: 1 } };
  const row = buildProtocolRow(ctx, {
    product: 'аб / в',
    dosage_value: 1,
    dosage_unit: 'ml',
    phi: 10,
  });
  const cb = row[0].callback_data;
  assert.ok(cb.includes('%2F'));
  assert.ok(cb.includes('%20'));
});

test('buildProtocolRow trims long product names', () => {
  const ctx = { from: { id: 1 } };
  const row = buildProtocolRow(ctx, {
    product: 'A'.repeat(120),
    dosage_value: 1,
    dosage_unit: 'ml',
    phi: 10,
  });
  const cb = row[0].callback_data;
  assert.ok(cb.length <= 64);
});

test('buildProtocolRow keeps product name cache', () => {
  const ctx = { from: { id: 1 } };
  const row = buildProtocolRow(ctx, {
    product: 'B'.repeat(40),
    dosage_value: 1,
    dosage_unit: 'ml',
    phi: 10,
  });
  const [, prod] = row[0].callback_data.split('|');
  const decoded = decodeURIComponent(prod);
  assert.equal(getProductName(decoded), 'B'.repeat(40));
});

test('getProductName caches hashed products', () => {
  const ctx = { from: { id: 1 } };
  let firstHash;
  let lastHash;
  for (let i = 0; i < 100; i++) {
    const row = buildProtocolRow(ctx, {
      product: `p${i}`,
      dosage_value: 1,
      dosage_unit: 'ml',
      phi: 10,
    });
    const [, hash] = row[0].callback_data.split('|');
    const decoded = decodeURIComponent(hash);
    if (i === 0) firstHash = decoded;
    if (i === 99) lastHash = decoded;
  }
  assert.equal(getProductName(lastHash), 'p99');
  assert.equal(getProductName(firstHash), 'p0');
});

test('photoHandler adds planning buttons', { concurrency: false }, async () => {
  const pool = { query: async () => {} };
  const replies = [];
  const ctx = {
    message: { photo: [{ file_id: 'id22', file_unique_id: 'u', width: 1, height: 1, file_size: 1 }] },
    from: { id: 101 },
    reply: async (msg, opts) => replies.push({ msg, opts }),
    telegram: { getFileLink: async () => ({ href: 'http://file' }) },
  };
  await withMockFetch({
    'http://file': { body: Readable.from(Buffer.from('x')) },
    default: { json: async () => ({ crop: 'apple', disease: 'scab', confidence: 0.55, treatment_plan: null, need_reshoot: true, reshoot_tips: ['Один лист'], next_steps: { reminder: 'Повтори', green_window: 'После дождя', cta: 'Переснять фото' } }) },
  }, async () => {
    await photoHandler(pool, ctx);
  });
  assert.equal(replies[0].msg, tr('photo_processing'));
  const buttons = replies[1].opts.reply_markup.inline_keyboard.flat();
  const cbs = buttons.map((btn) => btn.callback_data);
  assert.ok(cbs.includes('plan_treatment'));
  assert.ok(cbs.includes('phi_reminder'));
  assert.ok(cbs.includes('pdf_note'));
  assert.ok(cbs.includes('ask_products'));
  assert.ok(replies[1].msg.includes('⚠️ Пересъёмка'));
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
    'http://file': { body: Readable.from(Buffer.from('x')) },
    default: { status: 402, json: async () => ({ error: 'limit_reached', limit: 5 }) },
  }, async () => {
    await photoHandler(pool, ctx);
  });
  assert.equal(replies[0].msg, tr('photo_processing'));
  const paywallReply = replies[1];
  assert.equal(paywallReply.msg, tr('paywall', { limit: 4 }));
  const btns = paywallReply.opts.reply_markup.inline_keyboard[0];
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
  assert.equal(replies[0].msg, tr('faq_text'));
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
      [`${PAYMENTS_BASE}/create`]: { json: async () => ({ url: 'http://pay', payment_id: 'p1' }) },
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
  const req = calls.find((c) => c.url === `${PAYMENTS_BASE}/create`);
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
    [`${PAYMENTS_BASE}/create`]: { json: async () => ({ url: 'http://pay', payment_id: 'p2' }) },
    [`${PAYMENTS_BASE}/p2`]: {
      json: async () => ({ status: 'success', pro_expires_at: '2025-12-31T00:00:00Z' }),
    },
    default: { json: async () => ({ status: 'pending' }) },
  }, async () => {
    await buyProHandler(ctx, pool, 1, 50);
    if (ctx.pollPromise) await ctx.pollPromise;
  });
  const date = new Date('2025-12-31T00:00:00Z').toLocaleDateString('ru-RU');
  assert.equal(replies[1].msg, msg('payment_success', { date }));
});

test('buyProHandler polls fail', { concurrency: false }, async () => {
  const replies = [];
  const ctx = { from: { id: 3 }, answerCbQuery: () => {}, reply: async (msg, opts) => replies.push({ msg, opts }) };
  const pool = { query: async () => {} };
  await withMockFetch({
    [`${PAYMENTS_BASE}/create`]: { json: async () => ({ url: 'http://pay', payment_id: 'p3' }) },
    [`${PAYMENTS_BASE}/p3`]: { json: async () => ({ status: 'fail' }) },
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
      [`${PAYMENTS_BASE}/create`]: { ok: false, status: 500 },
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
      [`${PAYMENTS_BASE}/create`]: {
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
  const req = calls.find((c) => c.url === `${PAYMENTS_BASE}/create`);
  assert.equal(JSON.parse(req.opts.body).autopay, true);
});

test('cancelAutopay calls API with auth tokens', { concurrency: false }, async () => {
  const replies = [];
  const ctx = { from: { id: 5 }, reply: async (m) => replies.push(m) };
  const calls = [];
  await withMockFetch(
    {
      [`${API_BASE}/v1/auth/token`]: { json: async () => ({ jwt: 'j', csrf: 'c' }) },
      [`${PAYMENTS_BASE}/sbp/autopay/cancel`]: { status: 204 },
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
      [`${API_BASE}/v1/auth/token`]: { json: async () => ({ jwt: 'j', csrf: 'c' }) },
      [`${PAYMENTS_BASE}/sbp/autopay/cancel`]: { status: 401 },
    },
    async () => {
      await cancelAutopay(ctx);
    },
  );
  assert.equal(replies[0], msg('error_UNAUTHORIZED'));
});

test('cancelAutopay handles session error', { concurrency: false }, async () => {
  const replies = [];
  const ctx = { from: { id: 7 }, reply: async (m) => replies.push(m) };
  const calls = [];
  await withMockFetch(
    {
      [`${API_BASE}/v1/auth/token`]: { ok: false, status: 500 },
    },
    async () => {
      await cancelAutopay(ctx);
    },
    calls,
  );
  assert.equal(replies[0], tr('autopay_cancel_error'));
  assert.equal(calls.some((c) => c.url.endsWith('/autopay/cancel')), false);
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
    'http://file': { body: Readable.from(Buffer.from('x')) },
    default: { status: 202, json: async () => ({ status: 'pending', id: 42 }) },
  }, async () => {
    await photoHandler(pool, ctx);
  });
  assert.equal(replies[0].msg, tr('photo_processing'));
  const pendingReply = replies[1];
  assert.equal(pendingReply.msg, tr('diag_pending'));
  const btn = pendingReply.opts.reply_markup.inline_keyboard[0][0];
  assert.equal(btn.text, tr('retry_button'));
  assert.equal(btn.callback_data, 'retry|42');
});

test('retryHandler returns result', { concurrency: false }, async () => {
  const replies = [];
  const pool = { query: async () => [] };
  const ctx = { from: { id: 1 }, reply: async (msg, opts) => replies.push({ msg, opts }) };
  await withMockFetch({
    [`${API_BASE}/v1/photos/42`]: {
      json: async () => ({
        status: 'ok',
        crop: 'apple',
        disease: 'scab',
        confidence: 0.95,
        treatment_plan: { product: 'Скор', dosage: '2 мл', phi: '20', safety: 'Перчатки' },
        next_steps: { reminder: 'Повтор', green_window: 'Вечером', cta: 'Добавить обработку' },
      }),
    },
  }, async () => {
    await retryHandler(ctx, 42, pool);
  });
  assert.ok(replies[0].msg.includes('📸 Диагноз'));
  const callbacks = replies[0].opts.reply_markup.inline_keyboard.flat().map((btn) => btn.callback_data);
  assert.ok(callbacks.includes('plan_treatment'));
  assert.ok(callbacks.includes('phi_reminder'));
});

test('historyHandler paginates', { concurrency: false }, async () => {
  const replies = [];
  const events = [];
  const calls = [];
  const pool = { query: async (...a) => events.push(a) };
  const ctx = { from: { id: 1 }, reply: async (msg, opts) => replies.push({ msg, opts }) };
  await withMockFetch(
    {
      [`${API_BASE}/v1/photos?limit=10`]: {
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
    [`${API_BASE}/v1/photos?limit=10&cursor=abc`]: { json: async () => ({ items: [], next_cursor: null }) },
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
        [`${API_BASE}/v1/photos?limit=10`]: { json: async () => bad },
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

test('buildAssistantText uses assistant_ru when provided', () => {
  const text = buildAssistantText({
    assistant_ru: '📸 Диагноз\nКультура готова.',
    plan_missing_reason: null,
    need_reshoot: false,
  });
  assert.equal(text, '📸 Диагноз\nКультура готова.');
});

test('buildAssistantText falls back to structured text', () => {
  const text = buildAssistantText({
    crop: 'apple',
    disease: 'scab',
    confidence: 0.8,
    reasoning: ['Белый налёт'],
    treatment_plan: {
      substance: 'сера',
      method: 'Опрыскивание',
      phi_days: 14,
    },
    plan_missing_reason: 'нужно переснять',
    need_reshoot: true,
    reshoot_tips: ['Один лист'],
  });
  assert.ok(text.includes('📸 Диагноз'));
  assert.ok(text.includes('сера'));
  assert.ok(text.includes('нужно переснять'));
  assert.ok(text.includes('Один лист'));
});

test('buildAssistantText translates crop names', () => {
  const text = buildAssistantText({
    crop: 'apple',
    disease: 'scab',
    confidence: 0.8,
    treatment_plan: { substance: 'сера', method: 'Опрыскивание', phi_days: 14 },
  });
  assert.ok(text.includes('яблоня'));
});

test('buildKeyboardLayout includes clarify and reshoot buttons', () => {
  const keyboard = buildKeyboardLayout({
    need_clarify_crop: true,
    clarify_crop_variants: ['Виноград', 'Томат'],
    need_reshoot: true,
  });
  const labels = keyboard.inline_keyboard.flat().map((btn) => btn.text);
  assert.ok(labels.includes('Виноград'));
  assert.ok(labels.includes('Томат'));
  assert.ok(labels.includes(msg('cta.reshoot')));
});

test('resolveFollowupReply prioritizes assistant followups', () => {
  const reply = resolveFollowupReply(
    {
      assistant_followups_ru: ['Курс лечения: повторите через 10 дней.'],
    },
    'Курс лечения какой?',
  );
  assert.equal(reply, 'Курс лечения: повторите через 10 дней.');
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
      [`${PAYMENTS_BASE}/42`]: { json: async () => ({ status: 'processing' }) },
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
      [`${PAYMENTS_BASE}/42`]: { json: async () => ({ status: 'processing' }) },
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
      [`${PAYMENTS_BASE}/create`]: {
        json: async () => ({ payment_id: 1, url: 'http://pay' }),
      },
      [`${PAYMENTS_BASE}/1`]: {
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
