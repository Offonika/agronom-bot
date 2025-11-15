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
const { createPlanSlotHandlers } = require('./callbacks/plan_slot');
const {
  subscribeHandler,
  buyProHandler,
  pollPaymentStatus,
  cancelAutopay,
  getLimit,
} = require('./payments');
const { startHandler, helpHandler, feedbackHandler, newDiagnosisHandler } = require('./commands');
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

function createSessionDbStubs() {
  const store = { current: null, seq: 1 };
  const stubs = {
    purgeExpiredPlanSessions: async () => {},
    deletePlanSessionsForUser: async (userId) => {
      if (store.current?.user_id === userId) {
        store.current = null;
      }
    },
    createPlanSession: async (payload) => {
      const session = {
        id: store.seq++,
        user_id: payload.userId,
        token: payload.token,
        diagnosis_payload: payload.diagnosisPayload,
        recent_diagnosis_id: payload.recentDiagnosisId || null,
        object_id: payload.objectId || null,
        plan_id: payload.planId || null,
        current_step: payload.currentStep,
        state: payload.state || {},
        created_at: new Date(),
        updated_at: new Date(),
        expires_at: new Date(Date.now() + 60 * 60 * 1000),
      };
      store.current = session;
      return session;
    },
    getPlanSessionByToken: async (token) => (store.current?.token === token ? store.current : null),
    getLatestPlanSessionForUser: async (userId) => (store.current?.user_id === userId ? store.current : null),
    deletePlanSession: async (sessionId) => {
      if (store.current?.id === sessionId) {
        store.current = null;
        return true;
      }
      return false;
    },
    updatePlanSession: async (sessionId, patch = {}) => {
      if (!store.current || store.current.id !== sessionId) return null;
      const next = { ...store.current };
      if (patch.currentStep) next.current_step = patch.currentStep;
      if (patch.objectId !== undefined) next.object_id = patch.objectId;
      if (patch.planId !== undefined) next.plan_id = patch.planId;
      if (patch.recentDiagnosisId !== undefined) next.recent_diagnosis_id = patch.recentDiagnosisId;
      if (patch.diagnosisPayload) next.diagnosis_payload = patch.diagnosisPayload;
      if (patch.state) next.state = patch.state;
      store.current = next;
      return store.current;
    },
  };
  stubs.__sessionStore = store;
  return stubs;
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

function buildSlotContext(overrides = {}) {
  const slotStart = overrides.slot_start || new Date('2025-11-20T15:00:00.000Z');
  const slot = {
    id: overrides.id || 5,
    plan_id: overrides.plan_id || 2,
    stage_id: overrides.stage_id || 3,
    stage_option_id: overrides.stage_option_id || 7,
    slot_start: slotStart,
    slot_end: overrides.slot_end || new Date(slotStart.getTime() + 60 * 60 * 1000),
    status: overrides.status || 'proposed',
    reason: overrides.reason || ['☔ без дождя', '🌡 14 °C'],
    autoplan_run_id: overrides.autoplan_run_id ?? 11,
  };
  return {
    slot,
    plan: { id: slot.plan_id, user_id: overrides.plan_user_id || 1 },
    user: { id: overrides.user_id || 1, tg_id: overrides.tg_id || 123 },
    stage: {
      id: slot.stage_id,
      plan_id: slot.plan_id,
      kind: 'season',
      phi_days: 0,
      title: overrides.stage_title || 'Обработка',
    },
    stageOption: null,
    object: { id: overrides.object_id || 15, name: 'Ежевика' },
    autoplanRun: overrides.autoplanRun || { id: slot.autoplan_run_id, min_hours_ahead: 2, horizon_hours: 72 },
  };
}

function createCallbackCtx(data, telegramId = 123) {
  const replies = [];
  const answers = [];
  return {
    from: { id: telegramId },
    callbackQuery: { data },
    reply: async (text) => replies.push(text),
    answerCbQuery: async (text, opts) => answers.push({ text, opts }),
    __replies: replies,
    __answers: answers,
  };
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
  assert.equal(planFlowCalls.length, 0);
  assert.equal(replies[0].msg, tr('photo_processing'));
  const diagnosisReply = replies[1];
  assert.ok(diagnosisReply.msg.includes('📸 Диагноз'));
  assert.ok(diagnosisReply.msg.includes('⏰ Что дальше'));
  const callbacks = diagnosisReply.opts.reply_markup.inline_keyboard.flat().map((btn) => btn.callback_data);
  assert.ok(callbacks.includes('plan_treatment'));
  assert.ok(callbacks.includes('phi_reminder'));
});

test('planPickHandler enqueues autoplan job when queue available', async () => {
  const answers = [];
  const jobs = [];
  const planStatusUpdates = [];
  const handler = createPlanPickHandler({
    db: {
      ensureUser: async () => ({ id: 5 }),
      selectStageOption: async () => ({
        stage: { id: 12, plan_id: 77, kind: 'season', phi_days: 7 },
        option: { id: 3 },
      }),
      createAutoplanRun: async () => ({ id: 99 }),
      updatePlanStatus: async (payload) => planStatusUpdates.push(payload),
    },
    reminderScheduler: { scheduleMany: () => {} },
    autoplanQueue: { add: async (...args) => jobs.push(args) },
  });
  await handler({
    from: { id: 42 },
    callbackQuery: { data: 'pick_opt|77|12|3' },
    answerCbQuery: async (text) => answers.push(text),
  });
  assert.equal(jobs.length, 1);
  assert.equal(answers[0], msg('plan_autoplan_lookup'));
  assert.deepEqual(planStatusUpdates, [
    { planId: 77, userId: 5, status: 'accepted' },
  ]);
});

test('planPickHandler schedules treatment and phi reminders when autoplan unavailable', async () => {
  const answers = [];
  const remindersCaptured = [];
  const eventsCaptured = [];
  const scheduled = [];
  const planStatusUpdates = [];
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
      createReminders: async (reminders) => {
        remindersCaptured.push(...reminders);
        return reminders.map((reminder, idx) => ({ ...reminder, id: idx + 1 }));
      },
      updatePlanStatus: async (payload) => planStatusUpdates.push(payload),
    },
    reminderScheduler: { scheduleMany: (rem) => scheduled.push(...rem) },
    autoplanQueue: null,
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
  assert.equal(scheduled.length, 2);
  assert.equal(answers[0], msg('plan_saved_toast'));
  assert.deepEqual(planStatusUpdates, [
    { planId: 77, userId: 5, status: 'scheduled' },
  ]);
});

test('planPickHandler prompts manual selection when autoplan unavailable', async () => {
  const answers = [];
  const planStatusUpdates = [];
  const manualCalls = [];
  const handler = createPlanPickHandler({
    db: {
      ensureUser: async () => ({ id: 5 }),
      selectStageOption: async () => ({
        stage: { id: 12, plan_id: 77, kind: 'season', phi_days: 0 },
        option: { id: 3 },
      }),
      updatePlanStatus: async (payload) => planStatusUpdates.push(payload),
      getPlanSessionByPlan: async () => ({ id: 42, state: {} }),
      updatePlanSession: async () => manualCalls.push('session'),
    },
    manualSlots: {
      prompt: async () => {
        manualCalls.push('prompt');
        return true;
      },
    },
  });
  await handler({
    from: { id: 42 },
    callbackQuery: { data: 'pick_opt|77|12|3' },
    answerCbQuery: async (text) => answers.push(text),
  });
  assert.ok(manualCalls.includes('prompt'));
  assert.equal(answers[0], msg('plan_manual_prompt_toast'));
  assert.deepEqual(planStatusUpdates, [
    { planId: 77, userId: 5, status: 'accepted' },
  ]);
});

test('planPickHandler skips scheduling for trigger stages', async () => {
  const answers = [];
  const planStatusUpdates = [];
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
      updatePlanStatus: async (payload) => planStatusUpdates.push(payload),
    },
  });
  await handler({
    from: { id: 42 },
    callbackQuery: { data: 'pick_opt|77|12|3' },
    answerCbQuery: async (text) => answers.push(text),
  });
  assert.equal(answers[0], msg('plan_saved_wait_trigger'));
  assert.deepEqual(planStatusUpdates, [
    { planId: 77, userId: 5, status: 'accepted' },
  ]);
});

test('planFlow start prompts for object selection', async () => {
  const replies = [];
  const sessionStubs = createSessionDbStubs();
  const planFlow = createPlanFlow({
    db: {
      ...sessionStubs,
      ensureUser: async () => ({ id: 9, last_object_id: null }),
      listObjects: async () => [
        { id: 1, name: 'Авто объект', user_id: 9 },
        { id: 2, name: 'Запас', user_id: 9 },
      ],
      updateUserLastObject: async () => {},
    },
    catalog: {
      suggestStages: async () => [],
      suggestOptions: async () => [],
    },
    planWizard: {
      showPlanTable: async () => {},
    },
  });
  await planFlow.start(
    {
      from: { id: 77 },
      chat: { id: 1 },
      reply: async (msg, opts) => replies.push({ msg, opts }),
    },
    { crop: 'apple', confidence: 0.9 },
  );
  assert.ok(replies[0].msg.includes(msg('plan_step_choose_object')));
  assert.ok(replies[0].opts.reply_markup.inline_keyboard.length >= 1);
});

test('planFlow pick shows continue prompt', async () => {
  const replies = [];
  const answers = [];
  const sessionStubs = createSessionDbStubs();
  const planFlow = createPlanFlow({
    db: {
      ...sessionStubs,
      ensureUser: async () => ({ id: 33, last_object_id: null }),
      listObjects: async () => [
        { id: 1, name: 'Первый', user_id: 33 },
        { id: 2, name: 'Второй', user_id: 33 },
      ],
      updateUserLastObject: async () => {},
      getObjectById: async (id) => ({ id, name: id === 1 ? 'Первый' : 'Второй', user_id: 33 }),
    },
    catalog: {
      suggestStages: async () => [],
      suggestOptions: async () => [],
    },
    planWizard: {
      showPlanTable: async () => {},
    },
  });
  await planFlow.start(
    {
      from: { id: 33 },
      chat: { id: 900 },
      reply: async () => {},
    },
    { crop: 'apple', confidence: 0.95 },
  );
  const token = sessionStubs.__sessionStore.current?.token;
  await planFlow.pick(
    {
      from: { id: 33 },
      reply: async (msg, opts) => replies.push({ msg, opts }),
      answerCbQuery: async () => answers.push('ok'),
    },
    2,
    token,
  );
  assert.ok(replies[0].msg.includes('Шаг 1/3'));
  const buttons = replies[0].opts.reply_markup.inline_keyboard;
  assert.ok(buttons[0][0].callback_data.startsWith('plan_obj_confirm|2'));
  assert.ok(buttons[1][0].callback_data.startsWith('plan_obj_choose'));
  assert.equal(answers.length, 1);
});

test('planFlow auto builds plan when single object', async () => {
  const wizardCalls = [];
  const planPayloads = [];
  const planFlow = createPlanFlow({
    db: {
      ensureUser: async () => ({ id: 21, last_object_id: null }),
      listObjects: async () => [{ id: 5, name: 'Единственный', user_id: 21 }],
      updateUserLastObject: async () => {},
      getObjectById: async () => ({ id: 5, name: 'Единственный', user_id: 21, location_tag: null }),
      createCase: async () => ({ id: 501 }),
      createPlan: async (payload) => {
        planPayloads.push(payload);
        return { id: 601 };
      },
      createStagesWithOptions: async () => {},
      findPlanByHash: async () => null,
      findLatestPlanByObject: async () => null,
    },
    catalog: {
      suggestStages: async () => [{ title: 'Этап', kind: 'season', note: null, phi_days: 5, meta: {} }],
      suggestOptions: async () => [{ product: 'Препарат', dose_value: 10, dose_unit: 'г/10л', meta: {} }],
    },
    planWizard: {
      showPlanTable: async (chatId, planId, options) => wizardCalls.push({ chatId, planId, options }),
    },
  });
  await planFlow.start(
    {
      from: { id: 21 },
      chat: { id: 777 },
      reply: async () => {},
    },
    { crop: 'apple', disease: 'scab', confidence: 0.95 },
  );
  assert.equal(planPayloads.length, 1);
  assert.equal(wizardCalls[0].planId, 601);
  assert.equal(wizardCalls[0].options.userId, 21);
});

test('planCommands handleEventAction marks done', async () => {
  const replies = [];
  const updates = [];
  const planCommands = createPlanCommands({
    db: {
      ensureUser: async () => ({ id: 42 }),
      getEventByIdForUser: async () => ({
        id: 7,
        plan_id: 3,
        plan_title: 'План',
        stage_title: 'Этап',
      }),
      updateEventStatus: async (...args) => updates.push(args),
    },
    planWizard: { showPlanTable: async () => {} },
  });
  await planCommands.handleEventAction(
    { from: { id: 42 }, reply: async (msg) => replies.push(msg) },
    'done',
    '7',
  );
  assert.ok(updates.length === 1);
  assert.ok(replies[0].includes('Этап'));
});

test('planCommands handleEventAction reschedules', async () => {
  const replies = [];
  const updates = [];
  const planCommands = createPlanCommands({
    db: {
      ensureUser: async () => ({ id: 42 }),
      getEventByIdForUser: async () => ({
        id: 8,
        plan_id: 3,
        plan_title: 'План',
        stage_title: 'Этап',
        due_at: new Date('2025-01-01T12:00:00Z'),
      }),
      updateEventStatus: async (...args) => updates.push(args),
    },
    planWizard: { showPlanTable: async () => {} },
  });
  await planCommands.handleEventAction(
    { from: { id: 42 }, reply: async (msg) => replies.push(msg) },
    'reschedule',
    '8',
  );
  assert.ok(updates[0][0] === 8);
  assert.ok(replies[0].includes('Перенёс'));
});

test('planCommands handleEventAction cancels', async () => {
  const replies = [];
  const updates = [];
  const planCommands = createPlanCommands({
    db: {
      ensureUser: async () => ({ id: 42 }),
      getEventByIdForUser: async () => ({
        id: 9,
        plan_id: 3,
        plan_title: 'План',
        stage_title: 'Этап',
      }),
      updateEventStatus: async (...args) => updates.push(args),
    },
    planWizard: { showPlanTable: async () => {} },
  });
  await planCommands.handleEventAction(
    { from: { id: 42 }, reply: async (msg) => replies.push(msg) },
    'cancel',
    '9',
  );
  assert.ok(updates[0][1] === 'cancelled');
  assert.ok(replies[0].includes('отменён'));
});

test('planCommands handleEventAction opens plan', async () => {
  const replies = [];
  const wizardCalls = [];
  const planCommands = createPlanCommands({
    db: {
      ensureUser: async () => ({ id: 42 }),
      getPlanForUser: async () => ({ id: 5, title: 'План' }),
    },
    planWizard: {
      showPlanTable: async (chatId, planId) => wizardCalls.push({ chatId, planId }),
    },
  });
  await planCommands.handleEventAction(
    { from: { id: 42 }, chat: { id: 99 }, reply: async (msg) => replies.push(msg) },
    'open',
    '5',
  );
  assert.ok(wizardCalls[0].planId === 5);
  assert.ok(replies[0].includes('План'));
});

test('planFlow confirm creates plan and renders table', async () => {
  const wizardCalls = [];
  const planPayloads = [];
  const sessionStubs = createSessionDbStubs();
  const planFlow = createPlanFlow({
    db: {
      ...sessionStubs,
      ensureUser: async () => ({ id: 12, last_object_id: null }),
      listObjects: async () => [
        { id: 3, name: 'Грядка', user_id: 12 },
        { id: 4, name: 'Запас', user_id: 12 },
      ],
      createObject: async () => ({ id: 3, name: 'Грядка', user_id: 12 }),
      updateUserLastObject: async () => {},
      getObjectById: async () => ({ id: 3, name: 'Грядка', user_id: 12, location_tag: null }),
      createCase: async () => ({ id: 21 }),
      createPlan: async (payload) => {
        planPayloads.push(payload);
        return { id: 31 };
      },
      createStagesWithOptions: async () => {},
      findPlanByHash: async () => null,
      findLatestPlanByObject: async () => null,
    },
    catalog: {
      suggestStages: async () => [{ title: 'До цветения', kind: 'season', phi_days: 7, note: 'note', meta: {} }],
      suggestOptions: async () => [{ product: 'ХОМ', dose_value: 40, dose_unit: 'г/10л', meta: {} }],
    },
    planWizard: {
      showPlanTable: async (chatId, planId, options) => wizardCalls.push({ chatId, planId, options }),
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
  assert.equal(wizardCalls[0].options.userId, 12);
  assert.equal(wizardCalls[0].options.diffAgainst, null);
  assert.equal(planPayloads[0].source, 'catalog');
  assert.equal(planPayloads[0].hash, null);
  assert.deepEqual(planPayloads[0].payload, null);
  assert.equal(planPayloads[0].status, 'proposed');
  assert.equal(planPayloads[0].version, 1);
  assert.equal(planPayloads[0].plan_kind, 'PLAN_NEW');
});

test('planFlow confirm handles expired session gracefully', async () => {
  const answers = [];
  const sessionStubs = createSessionDbStubs();
  const planFlow = createPlanFlow({
    db: {
      ...sessionStubs,
      ensureUser: async () => ({ id: 99, last_object_id: null }),
      listObjects: async () => [
        { id: 5, name: 'Грядка', user_id: 99 },
        { id: 6, name: 'Запас', user_id: 99 },
      ],
      createObject: async () => ({ id: 5, name: 'Грядка', user_id: 99 }),
      updateUserLastObject: async () => {},
      getObjectById: async () => ({ id: 5, name: 'Грядка', user_id: 99 }),
      createCase: async () => ({ id: 501 }),
      createPlan: async () => ({ id: 601 }),
      createStagesWithOptions: async () => {},
      findPlanByHash: async () => null,
      findLatestPlanByObject: async () => null,
    },
    catalog: {
      suggestStages: async () => [],
      suggestOptions: async () => [],
    },
    planWizard: { showPlanTable: async () => {} },
  });
  await planFlow.start(
    {
      from: { id: 99 },
      chat: { id: 500 },
      reply: async () => {},
    },
    { crop: 'apple', confidence: 0.9 },
  );
  if (sessionStubs.__sessionStore.current) {
    sessionStubs.__sessionStore.current.expires_at = new Date(Date.now() - 1000);
  }
  await planFlow.confirm(
    {
      from: { id: 99 },
      chat: { id: 500 },
      answerCbQuery: async (text) => answers.push(text),
      reply: async () => {},
    },
    5,
  );
  assert.equal(answers[0], msg('plan_session_expired'));
});

test('planFlow uses machine plan when provided', async () => {
  const createdDefs = [];
  const planPayloads = [];
  const wizardCalls = [];
  const sessionStubs = createSessionDbStubs();
  const planFlow = createPlanFlow({
    db: {
      ...sessionStubs,
      ensureUser: async () => ({ id: 15, last_object_id: null }),
      listObjects: async () => [
        { id: 7, name: 'Грядка', user_id: 15 },
        { id: 8, name: 'Запас', user_id: 15 },
      ],
      createObject: async () => ({ id: 7, name: 'Грядка', user_id: 15 }),
      updateUserLastObject: async () => {},
      getObjectById: async () => ({ id: 7, name: 'Грядка', user_id: 15, location_tag: null }),
      createCase: async () => ({ id: 41 }),
      createPlan: async (payload) => {
        planPayloads.push(payload);
        return { id: 51 };
      },
      createStagesWithOptions: async (_planId, defs) => {
        createdDefs.push(...defs);
      },
      findPlanByHash: async () => null,
      findLatestPlanByObject: async () => null,
    },
    catalog: {
      suggestStages: async () => {
        throw new Error('catalog should not be called when plan_machine present');
      },
      suggestOptions: async () => [],
    },
    planWizard: {
      showPlanTable: async (chatId, planId, options) => wizardCalls.push({ chatId, planId, options }),
    },
  });
  const diagnosis = {
    crop: 'tomato',
    disease: 'blight',
    confidence: 0.9,
    plan_hash: 'abc123',
    plan_kind: 'PLAN_NEW',
    plan_machine: {
      stages: [
        {
          name: 'После осадков',
          trigger: 'после дождя >10 мм',
          options: [
            {
              product_name: 'Фунгицид',
              dose_value: 5,
              dose_unit: 'мл/10л',
              method: 'опрыскивание',
              phi_days: 10,
              needs_review: false,
            },
          ],
        },
      ],
    },
  };
  await planFlow.start(
    {
      from: { id: 15 },
      chat: { id: 77 },
      reply: async () => {},
    },
    diagnosis,
  );
  await planFlow.confirm(
    {
      from: { id: 15 },
      chat: { id: 77 },
      answerCbQuery: async () => {},
      reply: async () => {},
    },
    7,
  );
  assert.equal(createdDefs.length, 1);
  assert.equal(createdDefs[0].title, 'После осадков');
  assert.equal(createdDefs[0].options[0].product, 'Фунгицид');
  assert.equal(createdDefs[0].meta.source, 'ai');
  assert.equal(planPayloads[0].source, 'ai');
  assert.deepEqual(planPayloads[0].payload, diagnosis.plan_machine);
  assert.equal(planPayloads[0].hash, 'abc123');
  assert.equal(planPayloads[0].plan_kind, 'PLAN_NEW');
  assert.equal(planPayloads[0].status, 'proposed');
  assert.equal(planPayloads[0].version, 1);
  assert.equal(wizardCalls[0].options.userId, 15);
});

test('planFlow ignores QNA responses', async () => {
  let prompted = false;
  const planFlow = createPlanFlow({
    db: {
      ensureUser: async () => ({ id: 44, last_object_id: null }),
      listObjects: async () => [],
      createObject: async () => ({ id: 1, name: 'Auto' }),
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
      from: { id: 44 },
      reply: async () => {
        prompted = true;
      },
    },
    { plan_kind: 'QNA', confidence: 0.95 },
  );
  assert.equal(prompted, false);
});

test('planFlow skips duplicate plans by hash', async () => {
  const wizardCalls = [];
  const answers = [];
  const sessionStubs = createSessionDbStubs();
  const planFlow = createPlanFlow({
    db: {
      ...sessionStubs,
      ensureUser: async () => ({ id: 55, last_object_id: null }),
      listObjects: async () => [
        { id: 9, name: 'Грядка', user_id: 55 },
        { id: 10, name: 'Запас', user_id: 55 },
      ],
      createObject: async () => ({ id: 9, name: 'Грядка', user_id: 55 }),
      updateUserLastObject: async () => {},
      getObjectById: async () => ({ id: 9, name: 'Грядка', user_id: 55, location_tag: null }),
      createCase: async () => ({ id: 91 }),
      createPlan: async () => {
        throw new Error('plan should not be created for duplicates');
      },
      createStagesWithOptions: async () => {
        throw new Error('stages should not be created for duplicates');
      },
      findPlanByHash: async () => ({ id: 777 }),
      findLatestPlanByObject: async () => null,
    },
    catalog: {
      suggestStages: async () => [],
      suggestOptions: async () => [],
    },
    planWizard: {
      showPlanTable: async (chatId, planId, options) => wizardCalls.push({ chatId, planId, options }),
    },
  });
  const diagnosis = {
    crop: 'apple',
    disease: 'scab',
    confidence: 0.9,
    plan_kind: 'PLAN_NEW',
    plan_hash: 'dup123',
    plan_machine: {
      stages: [
        {
          name: 'Этап 1',
          options: [{ product_name: 'Фунгицид', needs_review: false }],
        },
      ],
    },
  };
  await planFlow.start(
    {
      from: { id: 55 },
      chat: { id: 21 },
      reply: async () => {},
    },
    diagnosis,
  );
  await planFlow.confirm(
    {
      from: { id: 55 },
      chat: { id: 21 },
      answerCbQuery: async (text) => answers.push(text),
      reply: async () => {},
    },
    9,
  );
  assert.equal(wizardCalls[0].planId, 777);
  assert.equal(wizardCalls[0].options.userId, 55);
  assert.equal(answers[0], msg('plan_object_duplicate'));
});

test('planFlow increments version for PLAN_UPDATE', async () => {
  const planPayloads = [];
  const wizardCalls = [];
  const answers = [];
  const sessionStubs = createSessionDbStubs();
  const planFlow = createPlanFlow({
    db: {
      ...sessionStubs,
      ensureUser: async () => ({ id: 66, last_object_id: null }),
      listObjects: async () => [
        { id: 11, name: 'Грядка', user_id: 66 },
        { id: 12, name: 'Запас', user_id: 66 },
      ],
      createObject: async () => ({ id: 11, name: 'Грядка', user_id: 66 }),
      updateUserLastObject: async () => {},
      getObjectById: async () => ({ id: 11, name: 'Грядка', user_id: 66, location_tag: null }),
      createCase: async () => ({ id: 101 }),
      createPlan: async (payload) => {
        planPayloads.push(payload);
        return { id: 888 };
      },
      createStagesWithOptions: async () => {},
      findPlanByHash: async () => null,
      findLatestPlanByObject: async () => ({ id: 777, version: 2, status: 'accepted' }),
    },
    catalog: {
      suggestStages: async () => [],
      suggestOptions: async () => [],
    },
    planWizard: {
      showPlanTable: async (chatId, planId, options) => {
        wizardCalls.push({ planId, options });
      },
    },
  });
  const diagnosis = {
    crop: 'tomato',
    disease: 'blight',
    confidence: 0.92,
    plan_kind: 'PLAN_UPDATE',
    plan_hash: 'upd-hash',
    plan_machine: {
      stages: [
        {
          name: 'Этап 2',
          options: [{ product_name: 'Раек', needs_review: true }],
        },
      ],
    },
  };
  await planFlow.start(
    {
      from: { id: 66 },
      chat: { id: 31 },
      reply: async () => {},
    },
    diagnosis,
  );
  await planFlow.confirm(
    {
      from: { id: 66 },
      chat: { id: 31 },
      answerCbQuery: async (text) => answers.push(text),
      reply: async () => {},
    },
    11,
  );
  assert.equal(planPayloads[0].version, 3);
  assert.equal(planPayloads[0].plan_kind, 'PLAN_UPDATE');
  assert.equal(planPayloads[0].status, 'proposed');
  assert.equal(answers[0], msg('plan_object_saved_update'));
  assert.equal(wizardCalls[0].options.userId, 66);
  assert.equal(wizardCalls[0].options.diffAgainst, 'accepted');
});

test('planCommands handlePlans lists upcoming events', async () => {
  const replies = [];
  const planCommands = createPlanCommands({
    db: {
      ensureUser: async () => ({ id: 1 }),
      listUpcomingEventsByUser: async () => [
        {
          id: 10,
          plan_id: 2,
          plan_title: 'План A',
          stage_title: 'Опрыскивание',
          due_at: new Date('2025-01-01T12:00:00Z'),
        },
      ],
      listObjects: async () => [],
      getObjectById: async () => null,
      updateUserLastObject: async () => {},
    },
    planWizard: { showPlanTable: async () => {} },
    objectChips: { send: async () => {} },
  });
  await planCommands.handlePlans({
    from: { id: 1 },
    reply: async (text, opts) => replies.push({ text, opts }),
  });
  assert.ok(replies[0].text.includes('Планы ближайших'));
  const buttons = replies[1].opts.reply_markup.inline_keyboard;
  assert.ok(buttons[0][0].callback_data === 'plan_event|done|10');
  assert.ok(buttons[1][1].callback_data === 'plan_event|open|2');
});

test('planCommands handleStats prints data', async () => {
  const replies = [];
  const planCommands = createPlanCommands({
    db: {
      getTopCrops: async () => [
        { name: 'томаты', cnt: 4 },
        { name: 'огурцы', cnt: 2 },
      ],
      getTopDiseases: async () => [
        { name: 'фитофтора', cnt: 3 },
        { name: 'мучнистая роса', cnt: 1 },
      ],
    },
    planWizard: { showPlanTable: async () => {} },
  });
  await planCommands.handleStats({
    reply: async (text) => replies.push(text),
  });
  assert.ok(replies[0].includes('томаты'));
  assert.ok(replies[0].includes('фитофтора'));
});

test('planTriggerHandler schedules events for trigger stage', async () => {
  const remindersSaved = [];
  const scheduled = [];
  const planStatusUpdates = [];
  const handler = createPlanTriggerHandler({
    db: {
      ensureUser: async () => ({ id: 6 }),
      getStageById: async () => ({
        id: 8,
        plan_id: 2,
        user_id: 6,
        kind: 'trigger',
        phi_days: 2,
        title: 'После дождя',
      }),
      createEvents: async (events) => events.map((event, idx) => ({ ...event, id: idx + 1 })),
      createReminders: async (reminders) => {
        remindersSaved.push(...reminders);
        return reminders.map((reminder, idx) => ({ ...reminder, id: idx + 1 }));
      },
      updatePlanStatus: async (payload) => planStatusUpdates.push(payload),
    },
    reminderScheduler: { scheduleMany: (rem) => scheduled.push(...rem) },
  });
  const promptReplies = [];
  await handler.prompt({
    from: { id: 6 },
    callbackQuery: { data: 'plan_trigger|2|8' },
    answerCbQuery: async () => promptReplies.push('ack'),
    reply: async (text) => promptReplies.push(text),
  });
  assert.ok(promptReplies.some((text) => typeof text === 'string' && text.includes('После дождя')));
  const confirmAnswers = [];
  await handler.confirm({
    from: { id: 6 },
    callbackQuery: { data: 'plan_trigger_at|2|8|0' },
    answerCbQuery: async (text) => confirmAnswers.push(text),
  });
  assert.ok(remindersSaved.length >= 1);
  assert.equal(scheduled.length, remindersSaved.length);
  assert.equal(confirmAnswers[0], msg('plan_trigger_scheduled'));
  assert.deepEqual(planStatusUpdates, [
    { planId: 2, userId: 6, status: 'scheduled' },
  ]);
});

test('planTriggerHandler accepts bigint ids returned as strings', async () => {
  const handler = createPlanTriggerHandler({
    db: {
      ensureUser: async () => ({ id: 7 }),
      getStageById: async () => ({
        id: 9,
        plan_id: '12',
        user_id: '7',
        kind: 'trigger',
        phi_days: 0,
        title: 'После дождя',
      }),
      createEvents: async (events) => events.map((event, idx) => ({ ...event, id: idx + 1 })),
      createReminders: async (reminders) => reminders,
    },
  });
  const promptReplies = [];
  await handler.prompt({
    from: { id: 7 },
    callbackQuery: { data: 'plan_trigger|12|9' },
    answerCbQuery: async () => promptReplies.push('ack'),
    reply: async (text) => promptReplies.push(text),
  });
  assert.ok(promptReplies.some((text) => typeof text === 'string' && text.includes('После дождя')));
  const confirmReplies = [];
  await handler.confirm({
    from: { id: 7 },
    callbackQuery: { data: 'plan_trigger_at|12|9|6' },
    answerCbQuery: async (text) => confirmReplies.push(text),
  });
  assert.equal(confirmReplies[0], msg('plan_trigger_scheduled'));
});

test('planCommands handlePlan uses wizard', async () => {
  const replies = [];
  const wizardCalls = [];
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
      showPlanTable: async (chatId, planId, options) => {
        wizardCalls.push({ chatId, planId, options });
      },
    },
    objectChips: { send: async () => {} },
  });
  await planCommands.handlePlan({
    from: { id: 42 },
    chat: { id: 42 },
    message: { text: '/plan 5' },
    reply: async (text) => replies.push(text),
  });
  assert.equal(wizardCalls[0].planId, 5);
  assert.equal(wizardCalls[0].options.userId, 1);
  assert.equal(wizardCalls[0].options.diffAgainst, 'accepted');
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
    objectChips: { send: async () => {} },
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
  rememberDiagnosis(55, { clarify_crop_variants: ['Виноград', 'Томат'] });
  await handleClarifySelection(ctx, '1');
  assert.equal(replies[0], msg('clarify.crop.confirm', { crop: 'Томат' }));
  assert.equal(getCropHint(55), 'Томат');
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

test('newDiagnosisHandler replies with hint', { concurrency: false }, async () => {
  const replies = [];
  const ctx = { reply: async (m) => replies.push(m) };
  await newDiagnosisHandler(ctx);
  assert.equal(replies[0], tr('new_command_hint'));
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

test('plan_slot accept schedules events and reminders', { concurrency: false }, async () => {
  const context = buildSlotContext();
  const eventCalls = [];
  const reminderCalls = [];
  const slotUpdates = [];
  const runUpdates = [];
  const planUpdates = [];
  const reminderScheduler = {
    scheduled: [],
    scheduleMany(remindersList) {
      this.scheduled.push(remindersList);
    },
  };
  const db = {
    getTreatmentSlotContext: async () => context,
    createEvents: async (events) => {
      eventCalls.push(events);
      return events.map((event, idx) => ({ ...event, id: idx + 1 }));
    },
    createReminders: async (remindersPayload) => {
      reminderCalls.push(remindersPayload);
      return remindersPayload.map((item, idx) => ({ ...item, id: idx + 1 }));
    },
    updateTreatmentSlot: async (id, patch) => slotUpdates.push({ id, patch }),
    updateAutoplanRun: async (id, patch) => runUpdates.push({ id, patch }),
    updatePlanStatus: async (payload) => planUpdates.push(payload),
  };
  const handlers = createPlanSlotHandlers({ db, reminderScheduler, autoplanQueue: null });
  const ctx = createCallbackCtx('plan_slot_accept|5');
  await handlers.accept(ctx);
  assert.equal(eventCalls.length, 1);
  assert.equal(reminderCalls.length, 1);
  assert.equal(reminderScheduler.scheduled.length, 1);
  assert.deepEqual(slotUpdates[0], { id: context.slot.id, patch: { status: 'accepted' } });
  assert.deepEqual(runUpdates[0], { id: context.slot.autoplan_run_id, patch: { status: 'accepted' } });
  assert.deepEqual(planUpdates[0], { planId: context.plan.id, userId: context.user.id, status: 'scheduled' });
  const expectedDate = new Intl.DateTimeFormat('ru-RU', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: process.env.AUTOPLAN_TIMEZONE || 'Europe/Moscow',
  }).format(context.slot.slot_start);
  const expectedTime = new Intl.DateTimeFormat('ru-RU', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: process.env.AUTOPLAN_TIMEZONE || 'Europe/Moscow',
  }).format(context.slot.slot_start);
  assert.equal(ctx.__answers[0].text, msg('plan_slot_confirmed_toast'));
  assert.equal(ctx.__replies[0], msg('plan_slot_confirmed', { date: expectedDate, time: expectedTime }));
});

test('plan_slot reschedule requeues autoplan', { concurrency: false }, async () => {
  const context = buildSlotContext();
  const slotUpdates = [];
  const runUpdates = [];
  const createdRuns = [];
  const autoplanAdds = [];
  const db = {
    getTreatmentSlotContext: async () => context,
    updateTreatmentSlot: async (id, patch) => slotUpdates.push({ id, patch }),
    updateAutoplanRun: async (id, patch) => runUpdates.push({ id, patch }),
    createAutoplanRun: async (payload) => {
      createdRuns.push(payload);
      return { id: 77 };
    },
  };
  const autoplanQueue = {
    add: async (name, payload, opts) => {
      autoplanAdds.push({ name, payload, opts });
    },
  };
  const handlers = createPlanSlotHandlers({ db, reminderScheduler: null, autoplanQueue });
  const ctx = createCallbackCtx('plan_slot_reschedule|5');
  await handlers.reschedule(ctx);
  assert.deepEqual(slotUpdates[0], { id: context.slot.id, patch: { status: 'rejected' } });
  assert.deepEqual(runUpdates[0], { id: context.slot.autoplan_run_id, patch: { status: 'rejected' } });
  assert.equal(createdRuns[0].stage_option_id, context.slot.stage_option_id);
  assert.equal(autoplanAdds[0].payload.runId, 77);
  assert.equal(ctx.__answers[0].text, msg('plan_slot_retry_toast'));
  assert.equal(ctx.__replies[0], msg('plan_slot_retry'));
});

test('plan_slot cancel stops pending slot', { concurrency: false }, async () => {
  const context = buildSlotContext();
  const slotUpdates = [];
  const runUpdates = [];
  const db = {
    getTreatmentSlotContext: async () => context,
    updateTreatmentSlot: async (id, patch) => slotUpdates.push({ id, patch }),
    updateAutoplanRun: async (id, patch) => runUpdates.push({ id, patch }),
  };
  const handlers = createPlanSlotHandlers({ db, reminderScheduler: null, autoplanQueue: null });
  const ctx = createCallbackCtx('plan_slot_cancel|5');
  await handlers.cancel(ctx);
  assert.deepEqual(slotUpdates[0], { id: context.slot.id, patch: { status: 'cancelled' } });
  assert.deepEqual(runUpdates[0], { id: context.slot.autoplan_run_id, patch: { status: 'cancelled' } });
  assert.equal(ctx.__answers[0].text, msg('plan_slot_cancelled_toast'));
  assert.equal(ctx.__replies[0], msg('plan_slot_cancelled'));
});
