const assert = require('node:assert/strict');
const { test } = require('node:test');
const { Readable } = require('node:stream');
const path = require('node:path');
const { Pool } = require(require.resolve('pg', { paths: [path.join(__dirname, '..')] }));
const { createDb } = require('../services/db');

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
  analyzePhoto,
} = require('./diagnosis');
const { createPlanPickHandler } = require('./callbacks/plan_pick');
const { createPlanTriggerHandler } = require('./callbacks/plan_trigger');
const { createPlanLocationHandler } = require('./callbacks/plan_location');
const { createPlanSlotHandlers } = require('./callbacks/plan_slot');
const { createPlanManualSlotHandlers } = require('./callbacks/plan_manual_slot');
const {
  subscribeHandler,
  buyProHandler,
  pollPaymentStatus,
  cancelAutopay,
  getLimit,
} = require('./payments');
const { startHandler, helpHandler, feedbackHandler, newDiagnosisHandler } = require('./commands');
const { getDocVersion } = require('./privacyNotice');
const { historyHandler } = require('./history');
const { reminderHandler, reminders } = require('./reminder');
const { createPlanCommands } = require('./planCommands');
const { createReminderScheduler } = require('./reminders');
const { createPlanFlow } = require('./planFlow');
const { createGeocoder } = require('../services/geocoder');
const { createAssistantChat } = require('./assistantChat');
const {
  rememberLocationRequest: rememberLocationSession,
  clearLocationRequest: clearLocationSession,
  peekLocationRequest,
} = require('./locationSession');
const {
  buildAssistantText,
  buildKeyboardLayout,
  resolveFollowupReply,
} = require('./messageFormatters/diagnosisMessage');
const strings = require('../locales/ru.json');
const { msg } = require('./utils');
const {
  addPhoto: addPhotoToAlbum,
  getState: getPhotoAlbumState,
  pickPrimary: pickPrimaryPhoto,
  clearSession: clearPhotoAlbum,
  skipOptional: skipOptionalPhotos,
  MIN_PHOTOS,
  MAX_PHOTOS,
} = require('./photoCollector');
const photoTips = require('./photoTips');
const locationThrottler = require('./locationThrottler');
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

/**
 * Creates minimal deps object for photoHandler tests.
 * Most photoHandler tests were written before deps refactoring and passed only pool.
 */
function createMinimalDeps(overrides = {}) {
  const mockClient = {
    query: async (...args) => overrides.queryResult || { rows: [] },
    release: () => {},
  };
  const mockPool = {
    query: async (...args) => overrides.queryResult || { rows: [] },
    connect: async () => mockClient,
    end: async () => {},
    ...overrides.pool,
  };
  const mockDb = {
    ensureUser: async () => ({ id: 5, api_key: 'test-key', ...overrides.user }),
    getUserByTgId: async () => ({ id: 5, api_key: 'test-key', ...overrides.user }),
    listObjects: async () => [],
    saveRecentDiagnosis: async () => ({ id: 1 }),
    logFunnelEvent: async () => {},
    createObject: async () => ({ id: 1, name: 'Test' }),
    updateUserLastObject: async () => ({}),
    updateUserBeta: async () => ({}),
    getConsentStatus: async () => null,
    ...overrides.db,
  };
  return {
    pool: mockPool,
    db: mockDb,
    planFlow: overrides.planFlow || { start: async () => {} },
    ...overrides.extra,
  };
}

function createPoolStub(overrides = {}) {
  const pool = Object.create(Pool.prototype);
  const { consentsOk = false } = overrides;
  const baseQuery = overrides.query || (async () => ({ rows: [] }));
  const query = async (text, params) => {
    if (consentsOk && typeof text === 'string' && text.includes('FROM user_consents')) {
      const docType = Array.isArray(params) ? params[1] : null;
      const privacyVersion = getDocVersion('privacy');
      const offerVersion = getDocVersion('offer');
      return {
        rows: [
          {
            status: true,
            doc_version: docType === 'privacy' ? privacyVersion : offerVersion,
          },
        ],
      };
    }
    const result = await baseQuery(text, params);
    return result === undefined ? { rows: [] } : result;
  };
  pool.query = query;
  pool.connect = overrides.connect || (async () => ({ query, release: () => {} }));
  pool.end = overrides.end || (async () => {});
  if (overrides.ensureUser) pool.ensureUser = overrides.ensureUser;
  if (overrides.getConsentStatus) pool.getConsentStatus = overrides.getConsentStatus;
  if (overrides.revokeConsent) pool.revokeConsent = overrides.revokeConsent;
  return pool;
}

function createConsentDb(overrides = {}) {
  const privacyVersion = getDocVersion('privacy');
  const offerVersion = getDocVersion('offer');
  return {
    getUserByTgId: async () => ({ id: overrides.userId || 1 }),
    ensureUser: async () => ({ id: overrides.userId || 1 }),
    getConsentStatus: async (_userId, docType) => ({
      status: true,
      doc_version: docType === 'privacy' ? privacyVersion : offerVersion,
    }),
    ...overrides,
  };
}

async function withSilencedConsoleErrors(fn) {
  const origError = console.error;
  console.error = () => {};
  try {
    await fn();
  } finally {
    console.error = origError;
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
  const objectId = overrides.object_id || 15;
  return {
    slot,
    plan: {
      id: slot.plan_id,
      user_id: overrides.plan_user_id || 1,
      object_id: overrides.plan_object_id || objectId,
    },
    user: { id: overrides.user_id || 1, tg_id: overrides.tg_id || 123 },
    stage: {
      id: slot.stage_id,
      plan_id: slot.plan_id,
      kind: 'season',
      phi_days: 0,
      title: overrides.stage_title || 'Обработка',
    },
    stageOption: null,
    object: { id: objectId, name: 'Ежевика' },
    autoplanRun: overrides.autoplanRun || { id: slot.autoplan_run_id, min_hours_ahead: 2, horizon_hours: 72 },
  };
}

function createCallbackCtx(data, telegramId = 123) {
  const replies = [];
  const answers = [];
  return {
    from: { id: telegramId },
    callbackQuery: { data },
    reply: async (text, opts) => replies.push({ text, opts }),
    answerCbQuery: async (text, opts) => answers.push({ text, opts }),
    __replies: replies,
    __answers: answers,
  };
}

test('photoHandler stores info and replies', { concurrency: false }, async () => {
  const calls = [];
  const planFlowCalls = [];
  // Mock client that implements release()
  const mockClient = {
    query: async (...args) => { calls.push(args); return { rows: [] }; },
    release: () => {},
  };
  const mockPool = {
    query: async (...args) => { calls.push(args); return { rows: [] }; },
    connect: async () => mockClient,
    end: async () => {},
  };
  // Provide a pre-built db mock that bypasses pool creation issues
  const mockDb = {
    ensureUser: async () => ({ id: 5, api_key: 'test-key' }),
    getUserByTgId: async () => ({ id: 5, api_key: 'test-key' }),
    listObjects: async () => [],
    saveRecentDiagnosis: async () => ({ id: 1 }),
    logFunnelEvent: async () => {},
    createObject: async () => ({ id: 1, name: 'Test' }),
    updateUserLastObject: async () => ({}),
    updateUserBeta: async () => ({}),
    getConsentStatus: async () => null,
  };
  const deps = {
    pool: mockPool,
    db: mockDb,
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
  // Marketing: Share button should be present for high confidence diagnoses
  const shareBtn = callbacks.find((cb) => cb && cb.startsWith('share_diag:'));
  assert.ok(shareBtn, 'Share button should be present');
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

test('planPickHandler shows fallback slot card when autoplan unavailable', async () => {
  const answers = [];
  const planStatusUpdates = [];
  const slotPayloads = [];
  const handler = createPlanPickHandler({
    db: {
      ensureUser: async () => ({ id: 5 }),
      selectStageOption: async () => ({
        stage: { id: 12, plan_id: 77, object_id: 90, title: 'Обработка', kind: 'season', phi_days: 7 },
        option: { id: 3 },
      }),
      upsertTreatmentSlot: async (payload) => {
        slotPayloads.push(payload);
        return {
          id: 555,
          plan_id: payload.plan_id,
          stage_id: payload.stage_id,
          stage_option_id: payload.stage_option_id,
          slot_start: payload.slot_start,
          slot_end: payload.slot_end,
          reason: payload.reason,
          status: payload.status,
        };
      },
      updatePlanStatus: async (payload) => planStatusUpdates.push(payload),
      getObjectById: async () => ({ id: 90, name: 'Грядка' }),
    },
    reminderScheduler: null,
    autoplanQueue: null,
  });
  const ctx = createCallbackCtx('pick_opt|77|12|3');
  await handler(ctx);
  assert.equal(planStatusUpdates[0].status, 'accepted');
  assert.equal(ctx.__answers[0].text, msg('plan_autoplan_ready'));
  assert.ok(ctx.__replies[0].text.includes('Шаг 3/3'));
  assert.ok(
    ctx.__replies[0].opts.reply_markup.inline_keyboard[0][0].callback_data.startsWith('plan_slot_accept'),
  );
  assert.equal(slotPayloads.length, 1);
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

test('planPickHandler logs funnel events', async () => {
  const funnelEvents = [];
  const handler = createPlanPickHandler({
    db: {
      ensureUser: async () => ({ id: 6 }),
      selectStageOption: async () => ({
        stage: { id: 10, plan_id: 77, object_id: 4, kind: 'season' },
        option: { id: 3 },
      }),
      updatePlanStatus: async () => {},
      logFunnelEvent: async (payload) => funnelEvents.push(payload),
      getPlanSessionByPlan: async () => null,
      upsertTreatmentSlot: async (payload) => ({
        id: 99,
        plan_id: payload.plan_id,
        stage_id: payload.stage_id,
        stage_option_id: payload.stage_option_id,
        slot_start: payload.slot_start,
        slot_end: payload.slot_end,
        reason: payload.reason,
      }),
      getObjectById: async () => ({ id: 4, name: 'Грядка' }),
    },
    manualSlots: { prompt: async () => false },
    autoplanQueue: null,
  });
  const ctx = createCallbackCtx('pick_opt|77|10|3', 6);
  await handler(ctx);
  const eventNames = funnelEvents.map((entry) => entry.event);
  assert.deepEqual(eventNames, ['option_picked']);
  assert.equal(ctx.__answers[0].text, msg('plan_autoplan_ready'));
  assert.ok(ctx.__replies[0].text.includes(msg('plan_slot_reason_default')));
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
  const chipCalls = [];
  planFlow.attachObjectChips({ send: async () => chipCalls.push('sent') });
  await planFlow.start(
    {
      from: { id: 77 },
      chat: { id: 1 },
      reply: async (msg, opts) => replies.push({ msg, opts }),
    },
    { crop: 'apple', confidence: 0.9 },
  );
  // When multiple objects exist and no explicit object_id, shows object choose prompt
  const prompt = replies.find((entry) => entry.msg?.includes(msg('plan_object_choose_prompt')));
  assert.ok(prompt, 'should show plan_object_choose_prompt');
  // Chips are not used in this flow - inline keyboard with objects is shown instead
  const nav = prompt.opts.reply_markup.inline_keyboard.flat();
  const objectBtn = nav.find((btn) => btn.text === 'Авто объект');
  assert.ok(objectBtn, 'should have object buttons');
});

test('planFlow auto-detects coordinates with geocoder', async () => {
  const updates = [];
  const geocoderCalls = [];
  const sessionStubs = createSessionDbStubs();
  const planFlow = createPlanFlow({
    db: {
      ...sessionStubs,
      ensureUser: async () => ({ id: 11, last_object_id: 5 }),
      listObjects: async () => [
        { id: 5, name: 'Грядка', user_id: 11, meta: {}, location_tag: 'Московская область' },
      ],
      updateUserLastObject: async () => {},
      updateObjectMeta: async (objectId, patch) => {
        updates.push({ objectId, patch });
        return { id: objectId, meta: patch };
      },
    },
    catalog: {
      suggestStages: async () => [],
      suggestOptions: async () => [],
    },
    planWizard: { showPlanTable: async () => {} },
    geocoder: {
      lookup: async (query) => {
        geocoderCalls.push(query);
        return { lat: 55.75, lon: 37.62, label: 'Москва', confidence: 0.9 };
      },
    },
  });
  await planFlow.start(
    {
      from: { id: 11 },
      chat: { id: 1 },
      reply: async () => {},
    },
    { crop: 'apple', confidence: 0.96, region: 'Москва' },
    { skipAutoFinalize: true },
  );
  assert.equal(geocoderCalls[0], 'Москва');
  const geoUpdate = updates.find((entry) => Number.isFinite(entry.patch?.lat));
  assert.ok(geoUpdate);
  assert.equal(geoUpdate.objectId, 5);
  assert.equal(geoUpdate.patch.lat, 55.75);
  assert.equal(geoUpdate.patch.location_source, 'geo_auto');
});

test('planFlow prompts manual location when coordinates missing', async () => {
  locationThrottler.reset();
  const replies = [];
  const sessionStubs = createSessionDbStubs();
  const object = { id: 1, name: 'Без координат', user_id: 22, meta: {} };
  const planFlow = createPlanFlow({
    db: {
      ...sessionStubs,
      ensureUser: async () => ({ id: 22, last_object_id: null }),
      listObjects: async () => [object],
      updateUserLastObject: async () => {},
      getObjectById: async () => ({ ...object, location_tag: null }),
      createCase: async () => ({ id: 501 }),
      createPlan: async () => ({ id: 601 }),
      createStagesWithOptions: async () => {},
      findPlanByHash: async () => null,
      findLatestPlanByObject: async () => null,
      linkRecentDiagnosisToPlan: async () => {},
      updateObjectMeta: async () => {},
    },
    catalog: {
      suggestStages: async () => [
        { title: 'Этап', kind: 'season', note: null, phi_days: 5, meta: {} },
      ],
      suggestOptions: async () => [
        { product: 'ХОМ', dose_value: 40, dose_unit: 'г/10л', meta: {} },
      ],
    },
    planWizard: { showPlanTable: async () => {} },
  });
  await planFlow.start(
    {
      from: { id: 22 },
      chat: { id: 5 },
      reply: async (text, opts) => replies.push({ text, opts }),
    },
    { crop: 'apple', confidence: 0.9 },
  );
  const prompt = replies.find((r) => r.text?.includes('Укажите участок вручную'));
  assert.ok(prompt);
  const keyboard = prompt.opts.reply_markup.inline_keyboard;
  assert.ok(keyboard[0][0].callback_data.startsWith('plan_location_geo|1'));
});

test('planFlow prompts confirmation for auto location', async () => {
  const replies = [];
  const sessionStubs = createSessionDbStubs();
  const object = {
    id: 4,
    name: 'Грядка',
    user_id: 13,
    meta: { location_source: 'geo_auto', geo_label: 'Калуга', lat: 54.5, lon: 36.3 },
    location_tag: 'Калужская область',
  };
  const planFlow = createPlanFlow({
    db: {
      ...sessionStubs,
      ensureUser: async () => ({ id: 13, last_object_id: null }),
      listObjects: async () => [object],
      updateUserLastObject: async () => {},
      getObjectById: async () => object,
      createCase: async () => ({ id: 701 }),
      createPlan: async () => ({ id: 801 }),
      createStagesWithOptions: async () => {},
      findPlanByHash: async () => null,
      findLatestPlanByObject: async () => null,
      linkRecentDiagnosisToPlan: async () => {},
      updateObjectMeta: async () => {},
    },
    catalog: {
      suggestStages: async () => [
        { title: 'Этап', kind: 'season', note: null, phi_days: 5, meta: {} },
      ],
      suggestOptions: async () => [
        { product: 'ХОМ', dose_value: 40, dose_unit: 'г/10л', meta: {} },
      ],
    },
    planWizard: { showPlanTable: async () => {} },
  });
  await planFlow.start(
    {
      from: { id: 13 },
      chat: { id: 2 },
      reply: async (text, opts) => replies.push({ text, opts }),
    },
    { crop: 'apple', confidence: 0.9 },
  );
  const prompt = replies.find((r) => r.text?.includes('Предположил координаты'));
  assert.ok(prompt);
  const buttons = prompt.opts.reply_markup.inline_keyboard;
  assert.ok(buttons[0][0].callback_data.startsWith('plan_location_confirm|4'));
  assert.ok(buttons[0][1].callback_data.startsWith('plan_location_change|4'));
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

test('planFlow auto builds plan when single object and shows nav', async () => {
  const wizardCalls = [];
  const planPayloads = [];
  const replies = [];
  const sessionStubs = createSessionDbStubs();
  const planFlow = createPlanFlow({
    db: {
      ...sessionStubs,
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
      linkRecentDiagnosisToPlan: async () => {},
    },
    catalog: {
      suggestStages: async () => [{ title: 'Этап', kind: 'season', note: null, phi_days: 5, meta: {} }],
      suggestOptions: async () => [{ product: 'Препарат', dose_value: 10, dose_unit: 'г/10л', meta: {} }],
    },
    planWizard: {
      showPlanTable: async (chatId, planId, options) => wizardCalls.push({ chatId, planId, options }),
    },
  });
  const chipCalls = [];
  planFlow.attachObjectChips({ send: async () => chipCalls.push('sent') });
  await planFlow.start(
    {
      from: { id: 21 },
      chat: { id: 777 },
      reply: async (msg, opts) => replies.push({ msg, opts }),
    },
    { crop: 'apple', disease: 'scab', confidence: 0.95 },
  );
  assert.equal(planPayloads.length, 1);
  assert.equal(wizardCalls[0].planId, 601);
  assert.equal(wizardCalls[0].options.userId, 21);
  assert.equal(chipCalls.length, 0);
  const stepMsg = replies.find((entry) => entry.msg?.includes('Шаг 2/3'));
  assert.ok(stepMsg);
  const navButtons = stepMsg.opts?.reply_markup?.inline_keyboard?.flat() || [];
  const backBtn = navButtons.find((btn) => btn.callback_data?.startsWith('plan_step_back|'));
  const cancelBtn = navButtons.find((btn) => btn.callback_data?.startsWith('plan_step_cancel|'));
  assert.ok(backBtn);
  assert.ok(cancelBtn);
});

test('planFlow watch emits plan_created with chatId', async () => {
  const events = [];
  const planFlow = createPlanFlow({
    db: {
      ensureUser: async () => ({ id: 50, last_object_id: null }),
      listObjects: async () => [{ id: 2, name: 'Куст', user_id: 50 }],
      updateUserLastObject: async () => {},
      getObjectById: async () => ({ id: 2, name: 'Куст', user_id: 50, location_tag: null }),
      createCase: async () => ({ id: 900 }),
      createPlan: async () => ({ id: 111 }),
      createStagesWithOptions: async () => {},
      findPlanByHash: async () => null,
      findLatestPlanByObject: async () => null,
      linkRecentDiagnosisToPlan: async () => {},
    },
    catalog: {
      suggestStages: async () => [{ title: 'Этап', kind: 'season', note: null, phi_days: 5, meta: {} }],
      suggestOptions: async () => [{ product: 'Препарат', dose_value: 10, dose_unit: 'г/10л', meta: {} }],
    },
    planWizard: { showPlanTable: async () => {} },
  });
  planFlow.watch((evt) => events.push(evt));
  await planFlow.start(
    {
      from: { id: 50 },
      chat: { id: 303 },
      reply: async () => {},
    },
    { crop: 'apple', disease: 'scab', confidence: 0.95 },
  );
  const evt = events[0];
  assert.equal(evt.type, 'plan_created');
  assert.equal(evt.planId, 111);
  assert.equal(evt.chatId, 303);
});

test('planFlow cancelSession removes stored token', async () => {
  const sessionStubs = createSessionDbStubs();
  const planFlow = createPlanFlow({
    db: {
      ...sessionStubs,
      ensureUser: async () => ({ id: 41, last_object_id: null }),
      listObjects: async () => [
        { id: 1, name: 'Первая', user_id: 41 },
        { id: 2, name: 'Вторая', user_id: 41 },
      ],
      updateUserLastObject: async () => {},
    },
    catalog: { suggestStages: async () => [], suggestOptions: async () => [] },
    planWizard: { showPlanTable: async () => {} },
  });
  await planFlow.start(
    {
      from: { id: 41 },
      chat: { id: 11 },
      reply: async () => {},
    },
    { crop: 'apple', confidence: 0.9 },
  );
  const token = sessionStubs.__sessionStore.current?.token;
  assert.ok(token);
  const cancelled = await planFlow.cancelSession(41, token);
  assert.equal(cancelled, true);
  assert.equal(sessionStubs.__sessionStore.current, null);
});

test('planFlow restartSession reopens choose step', async () => {
  const sessionStubs = createSessionDbStubs();
  const replies = [];
  const planFlow = createPlanFlow({
    db: {
      ...sessionStubs,
      ensureUser: async () => ({ id: 52, last_object_id: 7 }),
      listObjects: async () => [{ id: 7, name: 'Куст', user_id: 52 }],
      updateUserLastObject: async () => {},
    },
    catalog: { suggestStages: async () => [], suggestOptions: async () => [] },
    planWizard: { showPlanTable: async () => {} },
  });
  await planFlow.start(
    {
      from: { id: 52 },
      chat: { id: 12 },
      reply: async () => {},
    },
    { crop: 'apple', confidence: 0.9 },
    { skipAutoFinalize: true },
  );
  const token = sessionStubs.__sessionStore.current?.token;
  assert.ok(token);
  const restarted = await planFlow.restartSession(
    {
      from: { id: 52 },
      chat: { id: 12 },
      reply: async (msg) => replies.push(msg),
    },
    token,
  );
  assert.equal(restarted, true);
  const choosePrompt = replies.find((msg) => typeof msg === 'string' && msg.includes('Шаг 1/3'));
  assert.ok(choosePrompt);
});

test('planFlow logs object_selected funnel event on plan creation', async () => {
  const events = [];
  const planFlow = createPlanFlow({
    db: {
      ensureUser: async () => ({ id: 31, last_object_id: null }),
      listObjects: async () => [{ id: 4, name: 'Единственный', user_id: 31 }],
      updateUserLastObject: async () => {},
      getObjectById: async () => ({ id: 4, name: 'Единственный', user_id: 31 }),
      createCase: async () => ({ id: 911 }),
      createPlan: async () => ({ id: 333 }),
      createStagesWithOptions: async () => {},
      findPlanByHash: async () => null,
      findLatestPlanByObject: async () => null,
      logFunnelEvent: async (payload) => events.push(payload),
      linkRecentDiagnosisToPlan: async () => {},
    },
    catalog: {
      suggestStages: async () => [{ title: 'Этап', kind: 'season', note: null, phi_days: 5, meta: {} }],
      suggestOptions: async () => [{ product: 'Препарат', dose_value: 10, dose_unit: 'г/10л', meta: {} }],
    },
    planWizard: {
      showPlanTable: async () => {},
    },
  });
  await planFlow.start(
    {
      from: { id: 31 },
      chat: { id: 700 },
      reply: async () => {},
    },
    { crop: 'apple', disease: 'scab', confidence: 0.95 },
  );
  const record = events.find((entry) => entry.event === 'object_selected');
  assert.ok(record);
  assert.equal(record.planId, 333);
  assert.equal(record.objectId, 4);
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
        stage_id: 5,
        stage_option_id: 11,
      }),
      updateEventStatus: async (...args) => updates.push(args),
    },
    planWizard: { showPlanTable: async () => {} },
  });
  await planCommands.handleEventAction(
    {
      from: { id: 42 },
      reply: async (text, opts) => replies.push({ text, opts }),
    },
    'reschedule',
    '8',
  );
  assert.equal(updates[0][0], 8);
  assert.equal(updates[0][1], 'skipped');
  assert.ok(replies[0].text.includes('Выберите новое время'));
  const cb = replies[0].opts.reply_markup.inline_keyboard[0][0].callback_data;
  assert.equal(cb, 'plan_manual_start|3|5|11');
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
  assert.ok(updates[0][1] === 'skipped');
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
          object_name: 'Ежевика',
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
  assert.equal(replies[1].text, msg('plans_actions_hint'));
  const header = replies.find((entry) => entry.text?.includes('План «План A»'));
  assert.ok(header);
  const card = replies.find((entry) => entry.text?.includes('этап «Опрыскивание»'));
  const buttons = card.opts.reply_markup.inline_keyboard;
  assert.ok(buttons[0][0].callback_data === 'plan_event|done|10');
  assert.ok(buttons[1][1].callback_data === 'plan_event|open|2');
});

test('planCommands handleEventAction reschedule prompts manual picker', async () => {
  const replies = [];
  const updates = [];
  const planCommands = createPlanCommands({
    db: {
      ensureUser: async () => ({ id: 2 }),
      getEventByIdForUser: async () => ({
        id: 15,
        plan_id: 3,
        plan_title: 'План B',
        stage_id: 7,
        stage_title: 'Опрыскивание',
        stage_option_id: 9,
      }),
      updateEventStatus: async (...args) => updates.push(args),
    },
    planWizard: { showPlanTable: async () => {} },
  });
  await planCommands.handleEventAction(
    {
      from: { id: 2 },
      reply: async (text, opts) => replies.push({ text, opts }),
    },
    'reschedule',
    '15',
  );
  assert.equal(updates[0][1], 'skipped');
  assert.ok(replies[0].text.includes('Выберите новое время'));
  const cb = replies[0].opts.reply_markup.inline_keyboard[0][0].callback_data;
  assert.equal(cb, 'plan_manual_start|3|7|9');
});

test('planCommands handleEventAction done marks event as done', async () => {
  const replies = [];
  const updates = [];
  const planCommands = createPlanCommands({
    db: {
      ensureUser: async () => ({ id: 4 }),
      getEventByIdForUser: async () => ({
        id: 20,
        plan_title: 'План C',
        stage_title: 'Полив',
      }),
      updateEventStatus: async (...args) => updates.push(args),
    },
    planWizard: { showPlanTable: async () => {} },
  });
  await planCommands.handleEventAction(
    {
      from: { id: 4 },
      reply: async (text) => replies.push(text),
    },
    'done',
    '20',
  );
  assert.equal(updates[0][1], 'done');
  assert.ok(replies[0].includes(msg('event_marked_done', { stage: 'Полив', plan: 'План C' })));
});

test('planCommands handlePlans filter keyboard highlights object', async () => {
  const replies = [];
  const calls = [];
  const planCommands = createPlanCommands({
    db: {
      ensureUser: async () => ({ id: 3 }),
      listObjects: async () => [
        { id: 5, name: 'Ежевика' },
        { id: 6, name: 'Смородина' },
      ],
      listUpcomingEventsByUser: async (...args) => {
        calls.push(args);
        return [
          {
            id: 1,
            plan_id: 4,
            plan_title: 'План',
            stage_title: 'Этап',
            due_at: new Date('2025-01-02T12:00:00Z'),
          },
        ];
      },
    },
    planWizard: { showPlanTable: async () => {} },
  });
  await planCommands.handlePlans(
    {
      from: { id: 3 },
      reply: async (text, opts) => replies.push({ text, opts }),
    },
    { objectId: 6 },
  );
  assert.equal(calls[0][2], 6);
  const filterMsg = replies.find((entry) => entry.text === msg('plans_filter_prompt'));
  assert.ok(filterMsg);
  const filterButtons = filterMsg.opts.reply_markup.inline_keyboard.flat();
  const activeBtn = filterButtons.find((btn) => btn.callback_data === 'plan_plans_filter|6');
  assert.ok(activeBtn.text.startsWith('✅'));
});

test('planCommands handlePlans shows more button with cursor', async () => {
  const replies = [];
  const planCommands = createPlanCommands({
    db: {
      ensureUser: async () => ({ id: 7 }),
      listObjects: async () => [],
      listUpcomingEventsByUser: async () => {
        const now = Date.now();
        const buildEvent = (idx) => ({
          id: idx + 1,
          plan_id: 100 + idx,
          plan_title: `План ${idx}`,
          stage_title: `Этап ${idx}`,
          due_at: new Date(now + idx * 3600000),
        });
        return Array.from({ length: 6 }, (_, idx) => buildEvent(idx));
      },
    },
    planWizard: { showPlanTable: async () => {} },
  });
  await planCommands.handlePlans({
    from: { id: 7 },
    reply: async (text, opts) => replies.push({ text, opts }),
  });
  const moreMsg = replies.find((entry) => entry.text === msg('plans_more_hint'));
  assert.ok(moreMsg);
  const callback = moreMsg.opts.reply_markup.inline_keyboard[0][0].callback_data;
  assert.ok(callback.startsWith('plan_plans_more|'));
});

test('planCommands handlePlans with cursor skips overview', async () => {
  const replies = [];
  const cursorEvent = {
    id: 5,
    plan_id: 8,
    plan_title: 'План',
    stage_title: 'Этап',
    due_at: new Date('2025-01-01T12:00:00Z'),
  };
  const planCommands = createPlanCommands({
    db: {
      ensureUser: async () => ({ id: 9 }),
      listObjects: async () => [],
      listUpcomingEventsByUser: async (_userId, _limit, _objectId, cursor) => {
        assert.ok(cursor);
        return [cursorEvent];
      },
    },
    planWizard: { showPlanTable: async () => {} },
  });
  const cursor = `${cursorEvent.due_at.getTime()}:${cursorEvent.id}`;
  await planCommands.handlePlans(
    {
      from: { id: 9 },
      reply: async (text, opts) => replies.push({ text, opts }),
    },
    { cursor },
  );
  assert.equal(replies[0].text, msg('plans_more_hint'));
});

test('planCommands handlePlans shows overdue section', async () => {
  const replies = [];
  const planCommands = createPlanCommands({
    db: {
      ensureUser: async () => ({ id: 11 }),
      listObjects: async () => [],
      listUpcomingEventsByUser: async () => [
        {
          id: 1,
          plan_id: 2,
          plan_title: 'План',
          stage_title: 'Этап',
          due_at: new Date(Date.now() + 3600000),
        },
      ],
      listOverdueEventsByUser: async () => [
        {
          id: 99,
          plan_id: 2,
          plan_title: 'План',
          stage_title: 'Просрочено',
          due_at: new Date(Date.now() - 86400000),
        },
      ],
    },
    planWizard: { showPlanTable: async () => {} },
  });
  await planCommands.handlePlans({
    from: { id: 11 },
    reply: async (text, opts) => replies.push({ text, opts }),
  });
  const overdueHeader = replies.find((entry) => entry.text === msg('plans_overdue_header'));
  assert.ok(overdueHeader);
  const overdueCard = replies.find((entry) => entry.text?.includes('Просрочено'));
  assert.ok(overdueCard);
});

test('planCommands handleLocation updates coordinates from args', async () => {
  const replies = [];
  let updated = null;
  const planCommands = createPlanCommands({
    db: {
      ensureUser: async () => ({ id: 10, last_object_id: 5 }),
      getObjectById: async () => ({ id: 5, name: 'Грядка', user_id: 10, meta: {} }),
      listObjects: async () => [],
      updateUserLastObject: async () => {},
      updateObjectMeta: async (objectId, patch) => {
        updated = { objectId, patch };
        return { id: objectId, meta: patch };
      },
    },
    planWizard: { showPlanTable: async () => {} },
    objectChips: { send: async () => replies.push('chips') },
  });
  await planCommands.handleLocation({
    from: { id: 10 },
    message: { text: '/location 55.75 37.62' },
    reply: async (text) => replies.push(text),
  });
  assert.equal(updated.objectId, 5);
  assert.equal(updated.patch.lat, 55.75);
  assert.equal(updated.patch.lon, 37.62);
  assert.ok(replies[0].includes('координаты'));
});

test('planCommands handleObjects shows variety and note', async () => {
  const replies = [];
  const planCommands = createPlanCommands({
    db: {
      ensureUser: async () => ({ id: 50, last_object_id: 9 }),
      listObjects: async () => [
        { id: 9, name: 'яблоня', meta: { variety: 'Антоновка', note: 'Ряд 3, дерево 5' } },
        { id: 10, name: 'яблоня', meta: {} },
      ],
      updateUserLastObject: async () => {},
      createObject: async () => ({ id: 11, name: 'новое', meta: {} }),
    },
    planWizard: { showPlanTable: async () => {} },
  });
  await planCommands.handleObjects({
    from: { id: 50 },
    reply: async (msg) => replies.push(msg),
  });
  assert.ok(replies[0].includes('Антоновка'));
  assert.ok(replies[0].includes('Ряд 3'));
});

test('planCommands handleMerge merges objects', async () => {
  const replies = [];
  const calls = [];
  const planCommands = createPlanCommands({
    db: {
      ensureUser: async () => ({ id: 77 }),
      mergeObjects: async (...args) => calls.push(args),
    },
    planWizard: { showPlanTable: async () => {} },
  });
  await planCommands.handleMerge({
    message: { text: '/merge 3 1' },
    from: { id: 77 },
    reply: async (msg) => replies.push(msg),
  });
  assert.ok(calls.length === 1);
  assert.ok(replies[0].includes('3'));
});

test('db mergeObjects updates references inside transaction', async () => {
  const queries = [];
  const fakeClient = {
    query: async (text, params) => {
      queries.push({ text, params });
      const normalized = String(text).toLowerCase();
      if (normalized.includes('select') && normalized.includes('from objects')) {
        const id = Number(params?.[0]);
        return { rows: [{ id, user_id: 7 }] };
      }
      return { rows: [] };
    },
    release: () => {},
  };
  const pool = new Pool({ connectionString: 'postgres://test:test@localhost:5432/test' });
  pool.connect = async () => fakeClient;
  pool.end = async () => {};
  const db = createDb(pool);
  await db.mergeObjects(7, 1, 2);
  assert.ok(queries.some((q) => String(q.text).includes('BEGIN')));
  assert.ok(queries.some((q) => String(q.text).includes('DELETE FROM objects')));
  await pool.end();
});

test('planCommands handleEdit prompts variety/note buttons', async () => {
  const replies = [];
  const planCommands = createPlanCommands({
    db: {
      ensureUser: async () => ({ id: 51, last_object_id: 9 }),
      listObjects: async () => [{ id: 9, name: 'яблоня', meta: {} }],
    },
    planWizard: { showPlanTable: async () => {} },
  });
  await planCommands.handleEdit({
    message: { text: '/edit' },
    from: { id: 51 },
    reply: async (msg, opts) => replies.push({ msg, opts }),
  });
  assert.equal(replies.length, 1);
  const buttons = replies[0].opts?.reply_markup?.inline_keyboard || [];
  assert.ok(buttons.flat().some((b) => (b.text || '').includes('сорт')));
  assert.ok(buttons.flat().some((b) => (b.text || '').includes('метку')));
});

test('planCommands handleEdit shows switch button when multiple objects', async () => {
  const replies = [];
  const planCommands = createPlanCommands({
    db: {
      ensureUser: async () => ({ id: 51, last_object_id: 9 }),
      listObjects: async () => [
        { id: 9, name: 'яблоня', meta: {} },
        { id: 10, name: 'груша', meta: {} },
      ],
    },
    planWizard: { showPlanTable: async () => {} },
  });
  await planCommands.handleEdit({
    message: { text: '/edit' },
    from: { id: 51 },
    reply: async (msg, opts) => replies.push({ msg, opts }),
  });
  const buttons = replies[0].opts?.reply_markup?.inline_keyboard || [];
  assert.ok(buttons.flat().some((b) => (b.text || '').includes('актив')));
});

test('planCommands handleLocationShare stores location after prompt', async () => {
  const replies = [];
  let latestPatch = null;
  const db = {
    ensureUser: async () => ({ id: 12, last_object_id: null }),
    listObjects: async () => [{ id: 3, name: 'Грядка', user_id: 12, meta: {} }],
    updateUserLastObject: async () => {},
    getObjectById: async (id) => ({ id, name: 'Грядка', user_id: 12, meta: {} }),
    updateObjectMeta: async (objectId, patch) => {
      latestPatch = { objectId, patch };
      return { id: objectId, meta: patch };
    },
  };
  const planCommands = createPlanCommands({
    db,
    planWizard: { showPlanTable: async () => {} },
  });
  await planCommands.handleLocation({
    from: { id: 12 },
    message: { text: '/location' },
    reply: async (text) => replies.push(text),
  });
  assert.ok(replies.includes(msg('location_pending')));
  rememberLocationSession(12, 3, 'geo');
  await planCommands.handleLocationShare({
    from: { id: 12 },
    message: { location: { latitude: 55.71, longitude: 37.55 } },
    reply: async (text) => replies.push(text),
  });
  assert.equal(latestPatch.objectId, 3);
  assert.equal(latestPatch.patch.lat, 55.71);
  assert.equal(latestPatch.patch.lon, 37.55);
  assert.ok(replies.some((text) => typeof text === 'string' && text.includes('Сохранил координаты')));
});

test('planCommands handleLocationShare applies to last object without prompt', async () => {
  const replies = [];
  let latestPatch = null;
  const db = {
    ensureUser: async () => ({ id: 20, last_object_id: 7 }),
    listObjects: async () => [
      { id: 7, name: 'Яблоня', user_id: 20, meta: {} },
      { id: 8, name: 'Груша', user_id: 20, meta: {} },
    ],
    getObjectById: async (id) => ({ id, name: id === 7 ? 'Яблоня' : 'Груша', user_id: 20, meta: {} }),
    updateUserLastObject: async () => {},
    updateObjectMeta: async (objectId, patch) => {
      latestPatch = { objectId, patch };
      return { id: objectId, meta: patch };
    },
  };
  const planCommands = createPlanCommands({
    db,
    planWizard: { showPlanTable: async () => {} },
  });
  await planCommands.handleLocationShare({
    from: { id: 20 },
    message: { location: { latitude: 55.12345, longitude: 37.54321 } },
    reply: async (text) => replies.push(text),
  });
  assert.equal(latestPatch.objectId, 7);
  assert.equal(latestPatch.patch.lat, 55.12345);
  assert.equal(latestPatch.patch.lon, 37.54321);
  assert.ok(replies.some((text) => typeof text === 'string' && text.includes('координаты')));
});

test('planCommands handleLocationText geocodes address', async () => {
  const replies = [];
  const updates = [];
  const planCommands = createPlanCommands({
    db: {
      ensureUser: async () => ({ id: 15, last_object_id: null }),
      getObjectById: async () => ({ id: 7, name: 'Грядка', user_id: 15, meta: {} }),
      updateObjectMeta: async (objectId, patch) => {
        updates.push({ objectId, patch });
        return { id: objectId, meta: patch };
      },
    },
    planWizard: { showPlanTable: async () => {} },
    geocoder: {
      lookup: async () => ({ lat: 54.5, lon: 36.3, label: 'Калужская область' }),
    },
  });
  rememberLocationSession(15, 7, 'address');
  await planCommands.handleLocationText({
    from: { id: 15 },
    message: { text: 'Калуга, поле' },
    reply: async (text) => replies.push(text),
  });
  assert.equal(updates[0].objectId, 7);
  assert.equal(updates[0].patch.lat, 54.5);
  clearLocationSession(15);
});

test('planCommands handleLocationText reminds pending geo request', async () => {
  const replies = [];
  const planCommands = createPlanCommands({
    db: {
      ensureUser: async () => ({ id: 18, last_object_id: null }),
    },
    planWizard: { showPlanTable: async () => {} },
  });
  rememberLocationSession(18, 4, 'geo');
  const handled = await planCommands.handleLocationText({
    from: { id: 18 },
    message: { text: 'привет' },
    reply: async (text) => replies.push(text),
  });
  assert.equal(handled, true);
  assert.ok(replies.includes(msg('location_pending')));
  clearLocationSession(18);
});

test('planLocationHandler confirm updates meta', async () => {
  const updates = [];
  const handler = createPlanLocationHandler({
    db: {
      ensureUser: async () => ({ id: 1 }),
      getObjectById: async () => ({ id: 3, user_id: 1, meta: { location_source: 'geo_auto' } }),
      updateObjectMeta: async (objectId, patch) => {
        updates.push({ objectId, patch });
      },
    },
  });
  const replies = [];
  await handler.confirm({
    from: { id: 7 },
    callbackQuery: { data: 'plan_location_confirm|3' },
    answerCbQuery: async (text) => replies.push(text),
    reply: async (text) => replies.push(text),
  });
  assert.equal(updates[0].objectId, 3);
  assert.ok(updates[0].patch.location_confirmed);
});

test('planLocationHandler change points to /location', async () => {
  const handler = createPlanLocationHandler({
    db: {
      ensureUser: async () => ({ id: 1 }),
      getObjectById: async () => ({ id: 3, user_id: 1, meta: {} }),
    },
  });
  const replies = [];
  await handler.change({
    from: { id: 7 },
    callbackQuery: { data: 'plan_location_change|3' },
    reply: async (text, opts) => replies.push({ text, opts }),
    answerCbQuery: async (text) => replies.push(text),
  });
  const prompt = replies.find((entry) => typeof entry === 'object' && entry.text?.includes('обновить координаты'));
  assert.ok(prompt);
  assert.ok(prompt.opts.reply_markup.inline_keyboard[0][0].callback_data.includes('plan_location_geo'));
});

test('planLocationHandler requestGeo remembers session', async () => {
  clearLocationSession(5);
  const handler = createPlanLocationHandler({
    db: {
      ensureUser: async () => ({ id: 5 }),
      getObjectById: async () => ({ id: 9, user_id: 5, meta: {} }),
    },
  });
  const replies = [];
  await handler.requestGeo({
    from: { id: 5 },
    callbackQuery: { data: 'plan_location_geo|9' },
    answerCbQuery: async () => {},
    reply: async (text) => replies.push(text),
  });
  const { entry } = peekLocationRequest(5);
  assert.equal(entry.objectId, 9);
  assert.equal(entry.mode, 'geo');
  assert.ok(replies.includes(msg('location_geo_instructions')));
  assert.ok(replies.includes(msg('location_pending')));
  clearLocationSession(5);
});

test('planLocationHandler requestAddress remembers session', async () => {
  clearLocationSession(6);
  const handler = createPlanLocationHandler({
    db: {
      ensureUser: async () => ({ id: 6 }),
      getObjectById: async () => ({ id: 8, user_id: 6, meta: {} }),
    },
  });
  const replies = [];
  await handler.requestAddress({
    from: { id: 6 },
    callbackQuery: { data: 'plan_location_address|8' },
    answerCbQuery: async () => {},
    reply: async (text) => replies.push(text),
  });
  const { entry } = peekLocationRequest(6);
  assert.equal(entry.objectId, 8);
  assert.equal(entry.mode, 'address');
  assert.ok(replies.includes(msg('location_address_instructions')));
  assert.ok(replies.includes(msg('location_pending')));
  clearLocationSession(6);
});

test('planLocationHandler cancel clears request', async () => {
  rememberLocationSession(4, 2, 'address');
  const handler = createPlanLocationHandler({
    db: {
      ensureUser: async () => ({ id: 4 }),
      getObjectById: async () => ({ id: 2, user_id: 4, meta: {} }),
    },
  });
  await handler.cancel({
    from: { id: 50 },
    callbackQuery: { data: 'plan_location_cancel|2' },
    answerCbQuery: async () => {},
    reply: async () => {},
  });
  const { entry } = peekLocationRequest(4);
  assert.equal(entry, null);
});

test('createGeocoder caches repeated lookups', async () => {
  const cacheStore = new Map();
  const cache = {
    async get(key) {
      return cacheStore.get(key) || null;
    },
    async set(key, value) {
      cacheStore.set(key, value);
    },
  };
  let calls = 0;
  const geocoder = createGeocoder({
    cache,
    providerImpl: {
      lookup: async () => {
        calls += 1;
        return { lat: 10, lon: 20, label: 'Test' };
      },
    },
  });
  const first = await geocoder.lookup('Москва', { userId: 99 });
  const second = await geocoder.lookup('Москва', { userId: 99 });
  assert.ok(first && second);
  assert.equal(calls, 1);
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
  // When ensureUser fails, photoHandler returns diagnose_error (not db_error)
  // because the user cannot be verified
  const pool = createPoolStub({ query: async () => { throw new Error('fail'); } });
  const replies = [];
  let called = false;
  const ctx = {
    message: { photo: [{ file_id: 'id1', file_unique_id: 'u', width: 1, height: 1, file_size: 1 }] },
    from: { id: 1 },
    reply: async (msg) => replies.push(msg),
    telegram: { getFileLink: async () => { called = true; } },
  };
  await withSilencedConsoleErrors(async () => {
    await photoHandler(pool, ctx);
  });
  assert.equal(replies[0], msg('diagnose_error'));
  assert.equal(called, false);
});

test('photoHandler handles non-ok API status', { concurrency: false }, async () => {
  const deps = createMinimalDeps();
  const replies = [];
  const ctx = {
    message: { photo: [{ file_id: 'id1', file_unique_id: 'u', width: 1, height: 1, file_size: 1 }] },
    from: { id: 1 },
    reply: async (msg) => replies.push(msg),
    telegram: { getFileLink: async () => ({ href: 'http://file' }) },
  };
  await withSilencedConsoleErrors(async () => {
    await withMockFetch({
      'http://file': { body: Readable.from(Buffer.from('x')) },
      default: { ok: false, status: 500 },
    }, async () => {
      await photoHandler(deps, ctx);
    });
  });
  assert.equal(replies[0], tr('photo_processing'));
  assert.equal(replies[1], msg('diagnose_error'));
});

test('photoHandler responds with error_code message', { concurrency: false }, async () => {
  const deps = createMinimalDeps();
  const replies = [];
  const ctx = {
    message: { photo: [{ file_id: 'id1', file_unique_id: 'u', width: 1, height: 1, file_size: 1 }] },
    from: { id: 1 },
    reply: async (msg) => replies.push(msg),
    telegram: { getFileLink: async () => ({ href: 'http://file' }) },
  };
  await withSilencedConsoleErrors(async () => {
    await withMockFetch({
      'http://file': { body: Readable.from(Buffer.from('x')) },
      default: { ok: false, status: 400, json: async () => ({ code: 'NO_LEAF' }) },
    }, async () => {
      await photoHandler(deps, ctx);
    });
  });
  assert.equal(replies[0], tr('photo_processing'));
  assert.equal(replies[1], msg('error_NO_LEAF'));
});

test('photoHandler handles invalid JSON response', { concurrency: false }, async () => {
  const deps = createMinimalDeps();
  const replies = [];
  const ctx = {
    message: { photo: [{ file_id: 'id1', file_unique_id: 'u', width: 1, height: 1, file_size: 1 }] },
    from: { id: 1 },
    reply: async (msg) => replies.push(msg),
    telegram: { getFileLink: async () => ({ href: 'http://file' }) },
  };
  await withSilencedConsoleErrors(async () => {
    await withMockFetch({
      'http://file': { body: Readable.from(Buffer.from('x')) },
      default: { text: async () => '{invalid' },
    }, async () => {
      await photoHandler(deps, ctx);
    });
  });
  assert.equal(replies[0], tr('photo_processing'));
  assert.equal(replies[1], msg('diagnosis.parse_error'));
});

test('photoHandler rejects oversized photo', { concurrency: false }, async () => {
  const calls = [];
  const pool = createPoolStub({ query: async (...args) => { calls.push(args); } });
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
  await messageHandler({
    from: { id: 501 },
    message: { text: 'Привет' },
    reply: async (msg, opts) => replies.push({ msg, opts }),
  });
  assert.equal(replies[0].msg, msg('followup_default'));
  const button = replies[0].opts?.reply_markup?.inline_keyboard?.[0]?.[0];
  assert.equal(button?.text, msg('cta.ask_assistant'));
  assert.equal(button?.callback_data, 'assistant_entry');
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
  const deps = createMinimalDeps();
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
    await photoHandler(deps, ctx);
  });
  assert.equal(replies[0].msg, tr('photo_processing'));
  const buttons = replies[1].opts.reply_markup.inline_keyboard[0];
  assert.equal(buttons[0].text, '📄 Показать протокол');
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
  const deps = createMinimalDeps();
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
    await photoHandler(deps, ctx);
  });
  assert.equal(replies[0].msg, tr('photo_processing'));
  const buttons = replies[1].opts.reply_markup.inline_keyboard.flat();
  const cbs = buttons.map((btn) => btn.callback_data);
  assert.ok(cbs.includes('plan_treatment'));
  assert.ok(cbs.includes('ask_products'));
  assert.ok(cbs.includes('reshoot_photo'));
  assert.ok(replies[1].msg.includes('⚠️ Пересъёмка'));
});

test('photoHandler logs funnel events', { concurrency: false }, async () => {
  const events = [];
  const deps = {
    pool: { query: async () => {} },
    db: {
      ensureUser: async () => ({ id: 77, last_object_id: 3, api_key: 'test-key' }),
      saveRecentDiagnosis: async () => ({ id: 501, object_id: 9 }),
      logFunnelEvent: async (payload) => events.push(payload),
    },
    objectChips: { send: async () => {} },
  };
  const ctx = {
    message: { photo: [{ file_id: 'id90', file_unique_id: 'uniq', width: 2, height: 2, file_size: 2 }] },
    from: { id: 77 },
    reply: async () => {},
    telegram: { getFileLink: async () => ({ href: 'http://file' }) },
  };
  await withMockFetch(
    {
      'http://file': { body: Readable.from(Buffer.from('y')) },
      default: {
        json: async () => ({
          crop: 'apple',
          disease: 'scab',
          confidence: 0.9,
          treatment_plan: { product: 'Топаз', dosage: '2 мл', phi: '30', safety: 'Перчатки' },
          need_reshoot: false,
          reshoot_tips: [],
          next_steps: { reminder: 'Повтори', green_window: 'После дождя', cta: 'Запланировать' },
        }),
      },
    },
    async () => {
      await photoHandler(deps, ctx);
    },
  );
  const names = events.map((entry) => entry.event);
  assert.deepEqual(names, ['photo_received', 'diagnosis_shown']);
  const diagEvent = events.find((entry) => entry.event === 'diagnosis_shown');
  assert.equal(diagEvent.objectId, 9);
});

test('photoHandler paywall on 402', { concurrency: false }, async () => {
  const deps = createMinimalDeps();
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
    default: {
      status: 402,
      json: async () => ({
        error: 'limit_reached',
        limit: 1,
        limit_type: 'weekly_cases',
        reset_in_days: 3,
      }),
    },
  }, async () => {
    await photoHandler(deps, ctx);
  });
  assert.equal(replies[0].msg, tr('photo_processing'));
  const paywallReply = replies[1];
  assert.equal(paywallReply.msg, tr('paywall_weekly', { days: 3 }));
  const buttons = paywallReply.opts.reply_markup.inline_keyboard.flat();
  const callbacks = buttons.map((btn) => btn.callback_data).filter(Boolean);
  assert.ok(callbacks.includes('buy_pro'));
  assert.ok(callbacks.includes('paywall_remind|3'));
});

test('analyzePhoto sends case_id when linked', { concurrency: false }, async () => {
  const deps = createMinimalDeps();
  const replies = [];
  const calls = [];
  const ctx = {
    message: { photo: [{ file_id: 'id4', file_unique_id: 'u2', width: 1, height: 1, file_size: 1 }] },
    from: { id: 102 },
    reply: async (msg, opts) => replies.push({ msg, opts }),
    telegram: {
      getFileLink: async () => ({ href: 'http://file' }),
      editMessageText: async () => {},
    },
  };
  await withMockFetch(
    {
      'http://file': { body: Readable.from(Buffer.from('x')) },
      [`${API_BASE}/v1/ai/diagnose`]: {
        json: async () => ({ crop: 'apple', disease: 'scab', confidence: 0.9 }),
      },
    },
    async () => {
      await analyzePhoto(deps, ctx, ctx.message.photo[0], { linkedCaseId: 123 });
    },
    calls,
  );
  const apiCall = calls.find((call) => call.url.endsWith('/v1/ai/diagnose'));
  assert.ok(apiCall);
  assert.equal(apiCall.opts.body.get('case_id'), '123');
});

test('subscribeHandler shows paywall', { concurrency: false }, async () => {
  const replies = [];
  const ctx = { reply: async (msg, opts) => replies.push({ msg, opts }) };
  await subscribeHandler(ctx);
  assert.equal(replies[0].msg, msg('subscribe_prompt') || 'Подписка и оплата');
  const buttons = replies[0].opts.reply_markup.inline_keyboard.flat();
  const callbacks = buttons.map((btn) => btn.callback_data).filter(Boolean);
  assert.ok(callbacks.includes('buy_pro'));
  assert.ok(callbacks.includes('autopay_enable'));
  assert.ok(callbacks.includes('subscribe_back'));
  const faqButton = buttons.find((btn) => btn.url);
  assert.ok(faqButton.url.includes('start=faq'));
});

test('subscribeHandler logs paywall_shown', { concurrency: false }, async () => {
  const events = [];
  const pool = createPoolStub({
    query: async (...a) => events.push(a),
    ensureUser: async () => ({ id: 7, api_key: 'test-api-key' }),
    consentsOk: true,
  });
  const ctx = { from: { id: 7 }, reply: async () => {} };
  await subscribeHandler(ctx, pool);
  assert.equal(events.length, 1);
  assert.equal(
    events[0][0],
    'INSERT INTO analytics_events (user_id, event, utm_source, utm_medium, utm_campaign) VALUES ($1, $2, $3, $4, $5)'
  );
  assert.deepEqual(events[0][1], [7, 'subscribe_opened', null, null, null]);
});

test('startHandler logs paywall clicks', { concurrency: false }, async () => {
  const events = [];
  const pool = { query: async (...a) => events.push(a) };
  const db = createConsentDb();
  await startHandler({ startPayload: 'paywall', from: { id: 8 }, reply: async () => {} }, pool, { db });
  await startHandler({ startPayload: 'faq', from: { id: 9 }, reply: async () => {} }, pool, { db });
  const clicks = events.filter(([, params]) => params?.[1]?.startsWith('paywall_click'));
  assert.deepEqual(clicks, [
    [
      'INSERT INTO analytics_events (user_id, event, utm_source, utm_medium, utm_campaign) VALUES ($1, $2, $3, $4, $5)',
      [8, 'paywall_click_buy', null, null, null],
    ],
    [
      'INSERT INTO analytics_events (user_id, event, utm_source, utm_medium, utm_campaign) VALUES ($1, $2, $3, $4, $5)',
      [9, 'paywall_click_faq', null, null, null],
    ],
  ]);
});

test('startHandler saves utm from base64 payload', { concurrency: false }, async () => {
  let saved;
  const raw = 'src=tg|med=cpc|cmp=jan25';
  const encoded = Buffer.from(raw, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  const db = createConsentDb({
    saveUtm: async (_userId, utm) => {
      saved = utm;
    },
  });
  const ctx = { startPayload: encoded, from: { id: 11 }, reply: async () => {} };
  await startHandler(ctx, null, { db });
  assert.deepEqual(saved, { source: 'tg', medium: 'cpc', campaign: 'jan25' });
});

test('startHandler replies with onboarding text', { concurrency: false }, async () => {
  let reply;
  const ctx = {
    reply: async (m, opts) => { reply = { m, opts }; },
    startPayload: undefined,
    from: { id: 1 },
  };
  await startHandler(ctx, null, { db: createConsentDb({ userId: 1 }) });
  assert.equal(reply.m, tr('start'));
  assert.ok(reply.opts?.reply_markup?.keyboard?.length);
});

test('newDiagnosisHandler replies with hint', { concurrency: false }, async () => {
  const replies = [];
  const ctx = { reply: async (m, opts) => replies.push({ m, opts }) };
  await newDiagnosisHandler(ctx);
  assert.equal(replies[0].m, tr('new_command_hint'));
  assert.equal(replies[0].opts.reply_markup.inline_keyboard[0][0].callback_data, 'photo_tips');
  assert.equal(replies[0].opts.reply_markup.inline_keyboard[0][0].text, strings.photo_tips.button);
});

test('photoTips sends cards once per user', { concurrency: false }, async () => {
  const replies = [];
  const ctx = { from: { id: 555 }, reply: async (m) => replies.push(m) };
  await photoTips.sendTips(ctx);
  await photoTips.sendTips(ctx);
  assert.equal(replies[0], strings.photo_tips.intro);
  assert.deepEqual(replies.slice(1, 1 + strings.photo_tips.cards.length), strings.photo_tips.cards);
  assert.equal(replies[1 + strings.photo_tips.cards.length], strings.photo_tips.light);
  assert.equal(replies.at(-1), strings.photo_tips.already_sent);
});

test('photoTips offerHint sends hint only once', { concurrency: false }, async () => {
  const replies = [];
  const ctx = { from: { id: 556 }, reply: async (m, opts) => replies.push({ m, opts }) };
  await photoTips.offerHint(ctx);
  await photoTips.offerHint(ctx);
  assert.equal(replies.length, 1);
  assert.equal(replies[0].m, strings.photo_tips.hint);
  assert.equal(replies[0].opts.reply_markup.inline_keyboard[0][0].callback_data, 'photo_tips');
});

test('photoCollector enforces min/max and picks last photo', () => {
  const userId = 7777;
  clearPhotoAlbum(userId);
  let state = addPhotoToAlbum(userId, { photo: [{ file_id: 'p1', file_size: 1, width: 1, height: 1 }] });
  assert.equal(state.count, 1);
  assert.equal(state.ready, false);
  addPhotoToAlbum(userId, { photo: [{ file_id: 'p2', file_size: 1, width: 1, height: 1 }] });
  state = addPhotoToAlbum(userId, { photo: [{ file_id: 'p3', file_size: 1, width: 1, height: 1 }] });
  assert.equal(state.count, MIN_PHOTOS);
  assert.equal(state.ready, true);
  // exceed max
  for (let i = 4; i <= MAX_PHOTOS + 2; i += 1) {
    state = addPhotoToAlbum(userId, { photo: [{ file_id: `p${i}`, file_size: 1, width: 1, height: 1 }] });
  }
  assert.equal(state.count, MAX_PHOTOS);
  assert.equal(state.overflow, true);
  const primary = pickPrimaryPhoto(userId);
  assert.equal(primary.file_id, `p${MAX_PHOTOS}`);
  const snapshot = getPhotoAlbumState(userId);
  assert.equal(snapshot.count, MAX_PHOTOS);
  clearPhotoAlbum(userId);
});

test('photoCollector skip optional toggles flag', () => {
  const userId = 8888;
  clearPhotoAlbum(userId);
  addPhotoToAlbum(userId, { photo: [{ file_id: 'x1', file_size: 1, width: 1, height: 1 }] });
  let state = getPhotoAlbumState(userId);
  assert.equal(state.optionalSkipped, false);
  addPhotoToAlbum(userId, { photo: [{ file_id: 'x2', file_size: 1, width: 1, height: 1 }] });
  state = getPhotoAlbumState(userId);
  assert.equal(state.optionalSkipped, false);
  // skip optional
  skipOptionalPhotos(userId);
  state = getPhotoAlbumState(userId);
  assert.equal(state.optionalSkipped, true);
  clearPhotoAlbum(userId);
});

test('photoCollector resets expired session', () => {
  const userId = 9999;
  clearPhotoAlbum(userId);
  addPhotoToAlbum(userId, { photo: [{ file_id: 'y1', file_size: 1, width: 1, height: 1 }] });
  const { getState: getCollectorState } = require('./photoCollector');
  const sessions = require('./photoCollector').__getSessions
    ? require('./photoCollector').__getSessions()
    : null;
  if (sessions && sessions.has(userId)) {
    const s = sessions.get(userId);
    s.updatedAt = Date.now() - 31 * 60 * 1000; // expire
  }
  const state = getCollectorState(userId);
  assert.equal(state.count, 0);
  assert.equal(state.ready, false);
  clearPhotoAlbum(userId);
});

test('locationThrottler limits prompts per window', () => {
  locationThrottler.reset();
  const first = locationThrottler.remember(1);
  const second = locationThrottler.remember(1);
  const third = locationThrottler.remember(1);
  assert.equal(first.allowed, true);
  assert.equal(second.allowed, true);
  assert.equal(third.allowed, false);
});

test('startHandler replies with FAQ', { concurrency: false }, async () => {
  const replies = [];
  const ctx = { startPayload: 'faq', from: { id: 2 }, reply: async (m, opts) => replies.push({ msg: m, opts }) };
  await startHandler(ctx, null, { db: createConsentDb({ userId: 2 }) });
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
  const pool = createPoolStub({
    ensureUser: async () => ({ id: 1, api_key: 'test-api-key' }),
    consentsOk: true,
  });
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
  assert.equal(btn.text, tr('payment_button_card'));
  assert.equal(ctx.paymentId, 'p1');
  const req = calls.find((c) => c.url === `${PAYMENTS_BASE}/create`);
  assert.equal(req.opts.method, 'POST');
  assert.equal(req.opts.headers['Content-Type'], 'application/json');
  assert.equal(req.opts.headers['X-API-Key'], 'test-api-key');
  assert.equal(req.opts.headers['X-API-Ver'], 'v1');
  assert.equal(req.opts.headers['X-User-ID'], '1');
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
  const pool = createPoolStub({
    ensureUser: async () => ({ id: 2, api_key: 'test-api-key' }),
    consentsOk: true,
  });
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
  const pool = createPoolStub({
    ensureUser: async () => ({ id: 3, api_key: 'test-api-key' }),
    consentsOk: true,
  });
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
  const pool = createPoolStub({
    ensureUser: async () => ({ id: 6, api_key: 'test-api-key' }),
    consentsOk: true,
  });
  await withSilencedConsoleErrors(async () => {
    await withMockFetch(
      {
        [`${PAYMENTS_BASE}/create`]: { ok: false, status: 500 },
      },
      async () => {
        await buyProHandler(ctx, pool, 0);
      },
    );
  });
  assert.equal(replies[0].msg, msg('payment_error'));
});

test('buyProHandler sends autopay flag', { concurrency: false }, async () => {
  const replies = [];
  const ctx = {
    from: { id: 4 },
    answerCbQuery: () => {},
    reply: async (msg, opts) => replies.push({ msg, opts }),
  };
  const pool = createPoolStub({
    ensureUser: async () => ({ id: 4, api_key: 'test-api-key' }),
    consentsOk: true,
  });
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
  const pool = createPoolStub({
    ensureUser: async () => ({ id: 5, api_key: 'test-api-key' }),
  });
  await withMockFetch(
    {
      [`${API_BASE}/v1/auth/token`]: { json: async () => ({ jwt: 'j', csrf: 'c' }) },
      [`${PAYMENTS_BASE}/sbp/autopay/cancel`]: { status: 204 },
    },
    async () => {
      await cancelAutopay(ctx, pool);
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
  const pool = createPoolStub({
    ensureUser: async () => ({ id: 6, api_key: 'test-api-key' }),
  });
  await withMockFetch(
    {
      [`${API_BASE}/v1/auth/token`]: { json: async () => ({ jwt: 'j', csrf: 'c' }) },
      [`${PAYMENTS_BASE}/sbp/autopay/cancel`]: { status: 401 },
    },
    async () => {
      await cancelAutopay(ctx, pool);
    },
  );
  assert.equal(replies[0], msg('error_UNAUTHORIZED'));
});

test('cancelAutopay handles session error', { concurrency: false }, async () => {
  const replies = [];
  const ctx = { from: { id: 7 }, reply: async (m) => replies.push(m) };
  const calls = [];
  const pool = createPoolStub({
    ensureUser: async () => ({ id: 7, api_key: 'test-api-key' }),
  });
  await withMockFetch(
    {
      [`${API_BASE}/v1/auth/token`]: { ok: false, status: 500 },
    },
    async () => {
      await cancelAutopay(ctx, pool);
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
  assert.equal(replies[0].msg, msg('subscribe_prompt') || 'Подписка и оплата');
  delete process.env.PAYWALL_ENABLED;
});

test('photoHandler pending reply', { concurrency: false }, async () => {
  const deps = createMinimalDeps();
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
    await photoHandler(deps, ctx);
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
  const deps = createMinimalDeps();
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
    await retryHandler(ctx, 42, deps);
  });
  assert.ok(replies[0].msg.includes('📸 Диагноз'));
  const callbacks = replies[0].opts.reply_markup.inline_keyboard.flat().map((btn) => btn.callback_data);
  assert.ok(callbacks.includes('plan_treatment'));
  assert.ok(callbacks.includes('ask_products'));
});

test('historyHandler paginates', { concurrency: false }, async () => {
  const replies = [];
  const events = [];
  const calls = [];
  const pool = createPoolStub({
    query: async (...a) => events.push(a),
    ensureUser: async () => ({ id: 1, api_key: 'test-api-key' }),
  });
  pool.getCaseUsage = async () => ({ isPro: true });
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
  assert.equal(calls[0].opts.headers['X-User-ID'], '1');
});

test('historyHandler free shows current case only', { concurrency: false }, async () => {
  const replies = [];
  const pool = createPoolStub({
    ensureUser: async () => ({ id: 3, api_key: 'test-api-key' }),
  });
  pool.getCaseUsage = async () => ({ isPro: false, isBeta: false });
  pool.getLatestRecentDiagnosis = async () => ({
    created_at: '2025-01-02T00:00:00Z',
    diagnosis_payload: { crop: 'apple', disease: 'scab' },
  });
  const ctx = { from: { id: 3 }, reply: async (msg, opts) => replies.push({ msg, opts }) };
  await historyHandler(ctx, '', pool);
  assert.ok(replies[0].msg.includes('Текущий кейс'));
  const buttons = replies[0].opts.reply_markup.inline_keyboard.flat();
  assert.ok(buttons.some((btn) => btn.callback_data === 'buy_pro'));
});

test('historyHandler logs page event', { concurrency: false }, async () => {
  const events = [];
  const pool = createPoolStub({
    query: async (...a) => events.push(a),
    ensureUser: async () => ({ id: 2, api_key: 'test-api-key' }),
  });
  pool.getCaseUsage = async () => ({ isPro: true });
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
    const pool = createPoolStub({
      ensureUser: async () => ({ id: 1, api_key: 'test-api-key' }),
    });
    pool.getCaseUsage = async () => ({ isPro: true });
    const origErr = console.error;
    console.error = (...args) => {
      logged = args.join(' ');
    };
    await withMockFetch(
      {
        [`${API_BASE}/v1/photos?limit=10`]: { json: async () => bad },
      },
      async () => {
        await historyHandler(ctx, '', pool);
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
  const replies = [];
  const ctx = { reply: async (msg, opts) => replies.push({ msg, opts }) };
  const prevPrivacy = process.env.PRIVACY_URL;
  const prevOffer = process.env.OFFER_URL;
  process.env.PRIVACY_URL = 'https://privacy.example';
  process.env.OFFER_URL = 'https://offer.example';
  await helpHandler(ctx);
  assert.equal(
    replies[0].msg,
    msg('help', {
      policy_url: 'https://privacy.example',
      offer_url: 'https://offer.example',
    }),
  );
  assert.equal(replies[0].opts, undefined);
  if (prevPrivacy === undefined) {
    delete process.env.PRIVACY_URL;
  } else {
    process.env.PRIVACY_URL = prevPrivacy;
  }
  if (prevOffer === undefined) {
    delete process.env.OFFER_URL;
  } else {
    process.env.OFFER_URL = prevOffer;
  }
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

test('resolveFollowupReply ignores assistant followups without keyword', () => {
  const reply = resolveFollowupReply(
    {
      assistant_followups_ru: ['Уточните: листья стрелевидные или овальные?'],
    },
    'Привет',
  );
  assert.equal(reply, msg('followup_default'));
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
  const user = { id: 1, api_key: 'test-api-key' };
  await withMockFetch(
    {
      [`${PAYMENTS_BASE}/42`]: { json: async () => ({ status: 'processing' }) },
    },
    async () => {
      await pollPaymentStatus(ctx, 42, user, 1, 5);
    },
  );
  assert.equal(replies[0], msg('payment_pending'));
});

test('pollPaymentStatus treats bank_error as failure', { concurrency: false }, async () => {
  const replies = [];
  const ctx = { from: { id: 1 }, reply: async (m) => replies.push(m) };
  const user = { id: 1, api_key: 'test-api-key' };
  await withMockFetch(
    {
      [`${PAYMENTS_BASE}/42`]: { json: async () => ({ status: 'bank_error' }) },
    },
    async () => {
      await pollPaymentStatus(ctx, 42, user, 1, 5);
    },
  );
  assert.equal(replies[0], msg('payment_fail'));
});

test('pollPaymentStatus stops when aborted', { concurrency: false }, async () => {
  const replies = [];
  const ctx = { from: { id: 1 }, reply: async (m) => replies.push(m) };
  const user = { id: 1, api_key: 'test-api-key' };
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 2);
  await withMockFetch(
    {
      [`${PAYMENTS_BASE}/42`]: { json: async () => ({ status: 'processing' }) },
    },
    async () => {
      await pollPaymentStatus(ctx, 42, user, 10, 100, controller.signal);
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
  const pool = createPoolStub({
    ensureUser: async () => ({ id: 1, api_key: 'test-api-key' }),
    consentsOk: true,
  });
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

test('plan_manual_start callback prompts manual picker', async () => {
  const replies = [];
  const answers = [];
  const sessionUpdates = [];
  const handler = createPlanManualSlotHandlers({
    db: {
      ensureUser: async () => ({ id: 5 }),
      getStageById: async () => ({
        id: 12,
        plan_id: 77,
        user_id: 5,
        title: 'Обработка',
      }),
      getPlanSessionByPlan: async () => ({ id: 200, state: { foo: 'bar' } }),
      updatePlanSession: async (sessionId, patch) =>
        sessionUpdates.push({ sessionId, patch }),
    },
    reminderScheduler: null,
  });
  const ctx = createCallbackCtx('plan_manual_start|77|12|3', 5);
  ctx.reply = async (text, opts) => replies.push({ text, opts });
  ctx.answerCbQuery = async (text) => answers.push(text);
  await handler.start(ctx);
  assert.ok(replies[0].text.includes(msg('plan_manual_prompt', { stage: 'Обработка' })));
  const keyboard = replies[0].opts.reply_markup.inline_keyboard;
  assert.ok(keyboard.some((row) => row.some((btn) => btn.callback_data?.startsWith('plan_manual_slot|'))));
  assert.equal(answers[0], msg('plan_manual_prompt_toast'));
  assert.equal(sessionUpdates[0].sessionId, 200);
  assert.equal(sessionUpdates[0].patch.currentStep, 'time_manual_prompt');
});

test('plan_slot accept schedules events and reminders', { concurrency: false }, async () => {
  const context = buildSlotContext();
  const eventCalls = [];
  const reminderCalls = [];
  const slotUpdates = [];
  const runUpdates = [];
  const planUpdates = [];
  const funnelEvents = [];
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
    logFunnelEvent: async (payload) => funnelEvents.push(payload),
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
  assert.equal(ctx.__replies[0].text, msg('plan_slot_confirmed', { date: expectedDate, time: expectedTime }));
  assert.equal(funnelEvents[0].event, 'slot_confirmed');
  assert.equal(funnelEvents[0].planId, context.plan.id);
  assert.equal(funnelEvents[0].objectId, context.object.id);
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
  assert.equal(ctx.__replies[0].text, msg('plan_slot_retry'));
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
  assert.equal(ctx.__replies[0].text, msg('plan_slot_cancelled'));
});

test('assistantChat start uses recent object context', { concurrency: false }, async () => {
  const replies = [];
  const userId = 901;
  const objectId = 42;
  const recentRecord = {
    id: 1001,
    object_id: objectId,
    diagnosis_payload: { crop_ru: 'фикус' },
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  };
  const user = {
    id: 9,
    api_key: 'test-key',
    pro_expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    last_object_id: objectId,
  };
  const object = { id: objectId, name: 'Фикус', user_id: user.id };
  const db = {
    ensureUser: async () => user,
    listObjects: async () => [object],
    getObjectById: async () => object,
    getLatestRecentDiagnosis: async () => recentRecord,
  };
  const assistantChat = createAssistantChat({ db });
  rememberDiagnosis(userId, { object_id: objectId, recent_diagnosis_id: 1001 });
  const ctx = {
    from: { id: userId },
    reply: async (text, opts) => replies.push({ text, opts }),
  };
  await assistantChat.start(ctx);
  assert.equal(replies.length, 1);
  assert.ok(replies[0].text.includes('Фикус'));
  const buttons = replies[0].opts?.reply_markup?.inline_keyboard?.flat() || [];
  assert.ok(buttons.some((btn) => btn.callback_data === 'assistant_choose_object'));
});

test('assistantChat auto-starts on question without session', { concurrency: false }, async () => {
  const replies = [];
  const calls = [];
  const userId = 903;
  const objectId = 88;
  const user = {
    id: 18,
    api_key: 'test-api-key',
    pro_expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    last_object_id: objectId,
  };
  const object = { id: objectId, name: 'Алоэ', user_id: user.id };
  const db = {
    ensureUser: async () => user,
    listObjects: async () => [object],
    getObjectById: async () => object,
    updateUserLastObject: async () => ({}),
    getLatestPlanSessionForUser: async () => null,
  };
  const assistantChat = createAssistantChat({ db });
  rememberDiagnosis(userId, { object_id: objectId, recent_diagnosis_id: 6001 });
  const ctxMessage = {
    from: { id: userId },
    message: { text: 'Как поливать?' },
    reply: async (text, opts) => replies.push({ text, opts }),
  };
  await withMockFetch(
    {
      [`${API_BASE}/v1/assistant/chat`]: {
        json: async () => ({
          assistant_message: 'Поливайте раз в неделю.',
          followups: [],
          proposals: [],
        }),
      },
    },
    async () => {
      const handled = await assistantChat.handleMessage(ctxMessage);
      assert.equal(handled, true);
    },
    calls,
  );
  assert.equal(calls[0].url, `${API_BASE}/v1/assistant/chat`);
  assert.ok(replies[0].text.includes('Поливайте'));
});

test('assistantChat prompts to switch context on topic mismatch', { concurrency: false }, async () => {
  const replies = [];
  const userId = 905;
  const objectId = 55;
  const recentRecord = {
    id: 7001,
    object_id: objectId,
    diagnosis_payload: { crop_ru: 'драцена' },
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  };
  const user = {
    id: 19,
    api_key: 'test-api-key',
    pro_expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    last_object_id: objectId,
  };
  const object = { id: objectId, name: 'Драцена', type: 'indoor', user_id: user.id };
  const db = {
    ensureUser: async () => user,
    listObjects: async () => [object],
    getObjectById: async () => object,
    getLatestRecentDiagnosis: async () => recentRecord,
  };
  const assistantChat = createAssistantChat({ db });
  const ctxStart = { from: { id: userId }, reply: async () => {} };
  await assistantChat.start(ctxStart);
  const ctxMessage = {
    from: { id: userId },
    message: { text: 'Почему виноград бродит быстрее?' },
    reply: async (text, opts) => replies.push({ text, opts }),
  };
  await withMockFetch(
    {
      [`${API_BASE}/v1/assistant/chat`]: { json: async () => ({ assistant_message: 'ok' }) },
    },
    async () => {
      const handled = await assistantChat.handleMessage(ctxMessage);
      assert.equal(handled, true);
    },
  );
  const buttons = replies[0].opts?.reply_markup?.inline_keyboard?.flat() || [];
  assert.ok(replies[0].text.includes('виноград'));
  assert.ok(buttons.some((btn) => btn.callback_data === 'assistant_choose_object'));
  assert.ok(buttons.some((btn) => btn.callback_data === 'assistant_clear_context'));
});

test('assistantChat clearContext replays pending question', { concurrency: false }, async () => {
  const replies = [];
  const calls = [];
  const userId = 906;
  const objectId = 56;
  const recentRecord = {
    id: 7002,
    object_id: objectId,
    diagnosis_payload: { crop_ru: 'драцена' },
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  };
  const user = {
    id: 20,
    api_key: 'test-api-key',
    pro_expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    last_object_id: objectId,
  };
  const object = { id: objectId, name: 'Драцена', type: 'indoor', user_id: user.id };
  const db = {
    ensureUser: async () => user,
    listObjects: async () => [object],
    getObjectById: async () => object,
    getLatestPlanSessionForUser: async () => null,
    getLatestRecentDiagnosis: async () => recentRecord,
  };
  const assistantChat = createAssistantChat({ db });
  const ctxStart = { from: { id: userId }, reply: async () => {} };
  await assistantChat.start(ctxStart);
  const ctxMessage = {
    from: { id: userId },
    message: { text: 'Почему виноград бродит быстрее?' },
    reply: async (text, opts) => replies.push({ text, opts }),
  };
  const ctxClear = {
    from: { id: userId },
    reply: async (text, opts) => replies.push({ text, opts }),
    answerCbQuery: async () => {},
  };
  await withMockFetch(
    {
      [`${API_BASE}/v1/assistant/chat`]: {
        json: async () => ({
          assistant_message: 'Ответ без привязки',
          followups: [],
          proposals: [],
        }),
      },
    },
    async () => {
      await assistantChat.handleMessage(ctxMessage);
      await assistantChat.clearContext(ctxClear);
    },
    calls,
  );
  const req = calls.find((call) => call.url === `${API_BASE}/v1/assistant/chat`);
  assert.ok(req);
  const payload = JSON.parse(req.opts.body);
  assert.equal(payload.object_id, null);
});

test('assistantChat confirm dedupes repeated proposal', { concurrency: false }, async () => {
  const replies = [];
  const calls = [];
  const userId = 904;
  const objectId = 12;
  const user = {
    id: 19,
    api_key: 'test-api-key',
    pro_expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    last_object_id: objectId,
  };
  const object = { id: objectId, name: 'Антуриум', user_id: user.id };
  const db = {
    ensureUser: async () => user,
    listObjects: async () => [object],
    getObjectById: async () => object,
  };
  const assistantChat = createAssistantChat({ db });
  const ctx = {
    from: { id: userId },
    reply: async (text, opts) => replies.push({ text, opts }),
    answerCbQuery: async () => {},
    editMessageReplyMarkup: async () => {},
  };
  await withMockFetch(
    {
      [`${API_BASE}/v1/assistant/confirm_plan`]: {
        json: async () => ({ status: 'accepted', plan_id: 42 }),
      },
    },
    async () => {
      await assistantChat.confirm(ctx, 'p10', objectId);
      await assistantChat.confirm(ctx, 'p10', objectId);
    },
    calls,
  );
  const confirmCalls = calls.filter((c) => c.url === `${API_BASE}/v1/assistant/confirm_plan`);
  assert.equal(confirmCalls.length, 1);
  assert.equal(replies.length, 1);
});

test('assistantChat e2e: chat -> proposal -> confirm', { concurrency: false }, async () => {
  const replies = [];
  const confirmReplies = [];
  const calls = [];
  const userId = 902;
  const objectId = 77;
  const user = {
    id: 17,
    api_key: 'test-api-key',
    pro_expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    last_object_id: objectId,
  };
  const object = { id: objectId, name: 'Монстера', user_id: user.id };
  const db = {
    ensureUser: async () => user,
    listObjects: async () => [object],
    getObjectById: async () => object,
    updateUserLastObject: async () => ({}),
    getLatestPlanSessionForUser: async () => null,
  };
  const assistantChat = createAssistantChat({ db });
  rememberDiagnosis(userId, { object_id: objectId, recent_diagnosis_id: 5001 });
  const ctxStart = {
    from: { id: userId },
    reply: async (text, opts) => replies.push({ text, opts }),
  };
  const ctxMessage = {
    from: { id: userId },
    message: { text: 'Что делать дальше?' },
    reply: async (text, opts) => replies.push({ text, opts }),
  };
  await assistantChat.start(ctxStart);
  await withMockFetch(
    {
      [`${API_BASE}/v1/assistant/chat`]: {
        json: async () => ({
          assistant_message: 'Ответ ассистента',
          followups: ['Что дальше?'],
          proposals: [{ proposal_id: 'p1', kind: 'plan' }],
        }),
      },
      [`${API_BASE}/v1/assistant/confirm_plan`]: {
        json: async () => ({ status: 'accepted', plan_id: 55 }),
      },
    },
    async () => {
      const handled = await assistantChat.handleMessage(ctxMessage);
      assert.equal(handled, true);
      const reply = replies[1];
      assert.ok(reply.text.includes('Ответ ассистента'));
      assert.ok(reply.text.includes(msg('assistant.followups_title')));
      const buttons = reply.opts?.reply_markup?.inline_keyboard?.flat() || [];
      assert.ok(buttons.some((btn) => btn.callback_data === `assistant_pin|p1|${objectId}`));
      const ctxConfirm = {
        from: { id: userId },
        reply: async (text, opts) => confirmReplies.push({ text, opts }),
      };
      await assistantChat.confirm(ctxConfirm, 'p1', objectId);
    },
    calls,
  );
  assert.equal(calls[0].url, `${API_BASE}/v1/assistant/chat`);
  assert.equal(calls[1].url, `${API_BASE}/v1/assistant/confirm_plan`);
  assert.ok(confirmReplies[0].text.includes('Сохранил'));
  const confirmButtons = confirmReplies[0].opts?.reply_markup?.inline_keyboard?.flat() || [];
  assert.ok(confirmButtons.some((btn) => btn.callback_data === 'plan_plan_open|55'));
});
