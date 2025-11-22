'use strict';

const { msg } = require('./utils');
const { logFunnelEvent } = require('./funnel');
const { LOW_CONFIDENCE_THRESHOLD } = require('./messageFormatters/diagnosisMessage');
const { replyUserError } = require('./userErrors');
const { remember: rememberLocationPrompt } = require('./locationThrottler');

const PLAN_KIND_DEFAULT = 'PLAN_NEW';
const ROW_SIZE = 3;
const PLAN_KIND_SKIP = new Set(['QNA', 'FAQ']);
const PLAN_KIND_ALLOWED = new Set(['PLAN_NEW', 'PLAN_UPDATE']);
const LOCATION_PROMPT_TTL_MS = 30 * 60 * 1000; // 30 min prompt timeout
const LOCATION_AUTO_CONFIRM_TTL_MS = 12 * 60 * 60 * 1000; // 12h
const LOCATION_EXPIRE_MS = 30 * 60 * 1000; // 30 min for pending prompts
const DEFAULT_MAP_ZOOM = 15;

function createPlanFlow({ db, catalog, planWizard, geocoder = null, planSessions = null }) {
  if (!db || !catalog || !planWizard) {
    throw new Error('planFlow requires db, catalog and planWizard');
  }
  const sessionStore = createSessionStore({ db, planSessions });
  const watchers = new Set();
  let chipsHelper = null;

  async function cancelSession(userId, token) {
    if (!userId || !token) return false;
    const session = await sessionStore.fetchByToken(userId, token);
    if (!session) return false;
    await sessionStore.deleteSession(session);
    return true;
  }

  async function restartSession(ctx, token) {
    const userId = ctx?.from?.id;
    if (!userId || !token) return false;
    const session = await sessionStore.fetchByToken(userId, token);
    if (!session) return false;
    await sessionStore.deleteSession(session);
    await start(ctx, session.diagnosis_payload, { skipAutoFinalize: true });
    return true;
  }

  function notifyWatchers(event) {
    if (!watchers.size || !event) return;
    watchers.forEach((fn) => {
      try {
        fn(event);
      } catch (err) {
        console.error('plan_flow.watcher_error', err);
      }
    });
  }

  function attachObjectChips(helper) {
    chipsHelper = helper;
  }

  function buildPromptKeyboard(objectId, token) {
    const rows = [
      [{ text: msg('plan_object_yes'), callback_data: buildConfirmData(objectId, token) }],
      [{ text: msg('plan_object_choose'), callback_data: buildChooseData(token) }],
      [{ text: msg('plan_object_create'), callback_data: buildCreateData(token) }],
    ];
    return rows.concat(buildStepControls(token));
  }

  function formatStepPrompt(stepKey, text) {
    const prefix = msg(stepKey);
    return [prefix, text].filter(Boolean).join('\n\n');
  }

  function buildChooseKeyboard(objects, token) {
    if (!objects.length) return [];
    const buttons = objects.slice(0, 6).map((obj) => [
      { text: obj.name, callback_data: buildPickData(obj.id, token) },
    ]);
    return buttons.concat(buildStepControls(token));
  }

  function buildStepControls(token) {
    if (!token) return [];
    return [
      [
        { text: msg('plan_step_back'), callback_data: buildBackData(token) },
        { text: msg('plan_step_cancel'), callback_data: buildCancelData(token) },
      ],
    ];
  }

  function generateToken() {
    return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  }

  function isSessionExpired(session) {
    if (!session?.expires_at) return false;
    const expiresAt = new Date(session.expires_at);
    if (Number.isNaN(expiresAt.getTime())) return false;
    return expiresAt.getTime() < Date.now();
  }

  async function createPlanSessionRecord(user, diagnosis, token, initialStep = 'choose_object') {
    if (!token || !user?.id || !diagnosis) return null;
    await sessionStore.deleteForUser(user.id);
    return sessionStore.upsert(user, {
      token,
      diagnosisPayload: diagnosis,
      recentDiagnosisId: diagnosis.recent_diagnosis_id || null,
      objectId: user.last_object_id || null,
      currentStep: initialStep,
      state: {},
    });
  }

  async function resolvePlanSession(ctx, token = null, opts = {}) {
    const tgId = ctx.from?.id;
    if (!tgId) return { diagnosis: null, session: null, user: null, expired: false };
    const user = await db.ensureUser(tgId);
    if (!user) return { diagnosis: null, session: null, user: null, expired: false };
    let session = null;
    if (token) {
      session = await sessionStore.fetchByToken(user.id, token);
    } else {
      session = await sessionStore.fetchLatest(user.id);
    }
    const userKey = normalizeUserKey(user.id);
    const sessionUserKey = normalizeUserKey(session?.user_id);
    if (!session || !userKey || userKey !== sessionUserKey) {
      console.warn('plan_flow.session_missing', {
        userId: user.id,
        requestedToken: token || null,
        foundSessionId: session?.id ?? null,
        foundUserId: session?.user_id ?? null,
        tokenLookup: Boolean(token),
        userKey,
        sessionUserKey,
      });
      return { diagnosis: null, session: null, user, expired: false };
    }
    if (isSessionExpired(session)) {
      console.info('plan_flow.session_expired', { userId: user.id, token: session.token });
      await sessionStore.deleteSession(session);
      return { diagnosis: null, session: null, user, expired: true };
    }
    const payload = session.diagnosis_payload || {};
    const diagnosis = {
      ...payload,
      recent_diagnosis_id:
        payload.recent_diagnosis_id ?? session.recent_diagnosis_id ?? null,
    };
    if (opts.consume) {
      await sessionStore.deleteSession(session);
    } else {
      await sessionStore.updateSession(session, { currentStep: opts.step || session.current_step });
    }
    return { diagnosis, session, user, expired: false };
  }

  async function ensurePrimaryObject(user, diagnosis) {
    let objects = await db.listObjects(user.id);
    let primary = objects.find((obj) => obj.id === user.last_object_id) || objects[0];
    if (!primary) {
      primary = await db.createObject(user.id, {
        name: deriveObjectName(diagnosis),
        type: diagnosis?.crop || null,
        locationTag: diagnosis?.region || null,
        meta: { source: 'auto' },
      });
      objects = [primary];
    }
    await db.updateUserLastObject(user.id, primary.id);
    const enriched = await maybeAutodetectLocation(primary, diagnosis, user?.id);
    if (enriched && enriched !== primary) {
      primary = enriched;
      objects = objects.map((obj) => (obj.id === primary.id ? primary : obj));
    }
    return { primary, objects };
  }

  function hasCoordinates(meta = {}) {
    const lat = Number(meta.lat);
    const lon = Number(meta.lon);
    return Number.isFinite(lat) && Number.isFinite(lon);
  }

  function needsManualLocation(meta = {}) {
    if (hasCoordinates(meta)) return false;
    const promptedAt = meta.location_prompted_at ? new Date(meta.location_prompted_at) : null;
    if (!promptedAt || Number.isNaN(promptedAt.getTime())) return true;
    return Date.now() - promptedAt.getTime() > LOCATION_PROMPT_TTL_MS;
  }

  function pickLocationQuery(diagnosis, object) {
    if (diagnosis?.region && typeof diagnosis.region === 'string') {
      const trimmed = diagnosis.region.trim();
      if (trimmed) return trimmed;
    }
    if (object?.location_tag && typeof object.location_tag === 'string') {
      const trimmed = object.location_tag.trim();
      if (trimmed) return trimmed;
    }
    return null;
  }

  async function maybeAutodetectLocation(object, diagnosis, userId = null) {
    if (!geocoder || !object?.id) return object;
    if (typeof db.updateObjectMeta !== 'function') return object;
    if (hasCoordinates(object.meta)) return object;
    const query = pickLocationQuery(diagnosis, object);
    if (!query) return object;
    try {
      const geo = await geocoder.lookup(query, { language: 'ru', userId });
      if (!geo || !Number.isFinite(geo.lat) || !Number.isFinite(geo.lon)) return object;
      const updated = await db.updateObjectMeta(object.id, {
        lat: geo.lat,
        lon: geo.lon,
        geo_label: geo.label || query,
        geo_confidence: geo.confidence ?? null,
        location_source: 'geo_auto',
        location_updated_at: new Date().toISOString(),
      });
      if (updated) return updated;
    } catch (err) {
      console.error('plan_flow.geocode_failed', {
        objectId: object.id,
        query,
        message: err?.message,
      });
    }
    return object;
  }

  async function promptManualLocation(ctx, object) {
    if (!ctx?.reply || !object?.id) return;
    const userId = ctx.from?.id;
    const throttle = rememberLocationPrompt(userId);
    if (!throttle.allowed) {
      await ctx.reply(msg('location_prompt_limit'));
      return;
    }
    const meta = object.meta || {};
    const promptedAt = meta.location_prompted_at ? new Date(meta.location_prompted_at) : null;
    if (promptedAt && !Number.isNaN(promptedAt.getTime())) {
      const age = Date.now() - promptedAt.getTime();
      if (age > LOCATION_PROMPT_TTL_MS) {
        await ctx.reply(msg('location_expired_notice'));
      }
    }
    try {
      await ctx.reply(msg('location_manual_prompt', { name: object.name }), {
        reply_markup: {
          inline_keyboard: [
            [
              { text: msg('location_geo_button'), callback_data: `plan_location_geo|${object.id}` },
              { text: msg('location_address_button'), callback_data: `plan_location_address|${object.id}` },
            ],
            [{ text: msg('location_cancel_button'), callback_data: `plan_location_cancel|${object.id}` }],
          ],
        },
      });
      if (typeof db.updateObjectMeta === 'function') {
        await db.updateObjectMeta(object.id, {
          location_prompted: true,
          location_prompted_at: new Date().toISOString(),
        });
      }
    } catch (err) {
      console.error('plan_flow.location_prompt_failed', err);
    }
  }

  async function maybePromptLocationConfirmation(ctx, object, user) {
    if (!ctx?.reply || !object?.id) return;
    const meta = object.meta || {};
    const confirmedAt = meta.location_confirmed_at ? new Date(meta.location_confirmed_at) : null;
    if (meta.location_confirmed || (confirmedAt && Date.now() - confirmedAt.getTime() < LOCATION_AUTO_CONFIRM_TTL_MS))
      return;
    if (meta.location_prompted) {
      const promptedAt = meta.location_prompted_at ? new Date(meta.location_prompted_at) : null;
      if (promptedAt && Date.now() - promptedAt.getTime() < LOCATION_EXPIRE_MS) return;
    }
    if (meta.location_source !== 'geo_auto') return;
    const label = meta.geo_label || object.location_tag || msg('location_guess_fallback');
    const mapLink = buildMapLink(meta.lat, meta.lon);
    const keyboard = {
      inline_keyboard: [
        [
          { text: msg('location_confirm_button'), callback_data: `plan_location_confirm|${object.id}` },
          { text: msg('location_change_button'), callback_data: `plan_location_change|${object.id}` },
        ],
      ],
    };
    if (mapLink) {
      keyboard.inline_keyboard.push([
        { text: msg('location_map_button') || 'Открыть карту', url: mapLink },
      ]);
    }
    await ctx.reply(msg('location_guess_prompt', { label }), { reply_markup: keyboard });
    if (user?.id) {
      try {
        await logFunnelEvent(db, {
          event: 'location_guess_prompt',
          userId: user.id,
          objectId: object.id,
          data: { source: meta.location_source || 'geo_auto', label },
        });
      } catch (err) {
        console.error('plan_flow.location_prompt_log_failed', err);
      }
    }
    if (typeof db.updateObjectMeta === 'function') {
      try {
        await db.updateObjectMeta(object.id, { location_prompted: true, location_prompted_at: new Date().toISOString() });
      } catch (err) {
        console.error('plan_flow.location_prompt_mark_failed', err);
      }
    }
  }

  function buildMapLink(lat, lon, zoom = DEFAULT_MAP_ZOOM) {
    const latitude = Number(lat);
    const longitude = Number(lon);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
    return `https://www.openstreetmap.org/?mlat=${latitude.toFixed(6)}&mlon=${longitude.toFixed(6)}#map=${zoom}/${latitude.toFixed(6)}/${longitude.toFixed(6)}`;
  }

  async function start(ctx, diagnosis, opts = {}) {
    if (!ctx?.from?.id || !diagnosis || (diagnosis.confidence ?? 0) < LOW_CONFIDENCE_THRESHOLD) {
      console.warn('plan_flow.start.skipped_context', {
        hasUser: Boolean(ctx?.from?.id),
        hasDiagnosis: Boolean(diagnosis),
        confidence: diagnosis?.confidence ?? null,
      });
      return;
    }
    const planKind = normalizePlanKind(diagnosis.plan_kind);
    const tgUserId = ctx.from.id;
    if (PLAN_KIND_SKIP.has(planKind) || !PLAN_KIND_ALLOWED.has(planKind)) {
      console.info('plan_flow.start.skipped_kind', { userId: tgUserId, planKind });
      return;
    }
    const payload = { ...diagnosis, plan_kind: planKind };
    try {
      const user = await db.ensureUser(tgUserId);
      const { primary, objects } = await ensurePrimaryObject(user, payload);
      if (needsManualLocation(primary.meta || {})) {
        await promptManualLocation(ctx, primary);
      } else {
        await maybePromptLocationConfirmation(ctx, primary, user);
      }
      if (Array.isArray(objects) && objects.length === 1) {
        if (opts.skipAutoFinalize) {
          const token = generateToken();
          const session = await createPlanSessionRecord(user, payload, token);
          if (!session) return;
          await ctx.reply(
            formatStepPrompt(
              'plan_step_choose_object',
              msg('plan_object_prompt', { name: primary.name }),
            ),
            {
              reply_markup: { inline_keyboard: buildPromptKeyboard(primary.id, token) },
            },
          );
        } else {
          await ctx.reply(msg('plan_single_auto', { name: primary.name }), {
            reply_markup: {
              inline_keyboard: [
                [
                  {
                    text: msg('plan_single_change_button'),
                    callback_data: 'plan_error_objects',
                  },
                ],
              ],
            },
          });
          await finalizePlan(ctx, ctx.from.id, primary.id, payload);
        }
        return;
      }
      const token = generateToken();
      const session = await createPlanSessionRecord(user, payload, token);
      if (!session) return;
      console.info('plan_flow.start', {
        userId: user.id,
        tgUserId,
        planKind,
        objectId: primary.id,
        token,
        diagnosisHash: payload.plan_hash || null,
      });
      if (chipsHelper?.send) {
        try {
          await chipsHelper.send(ctx);
        } catch (err) {
          console.error('plan_flow.chips_send_failed', err);
        }
        const nav = buildStepControls(token);
        await ctx.reply(formatStepPrompt('plan_step_choose_object', msg('plan_step_choose_chips')), {
          reply_markup: nav.length ? { inline_keyboard: nav } : undefined,
        });
        return;
      }
      const inline = buildChipsInlineKeyboard(objects, user.last_object_id || primary.id, token);
      if (inline) {
        console.info('plan_flow.chips_prompt_inline', {
          userId: user.id,
          token,
          objectCount: objects.length,
        });
        await ctx.reply(msg('plan_step_choose_object'), { reply_markup: inline });
        return;
      }
      await ctx.reply(formatStepPrompt('plan_step_choose_object', msg('plan_object_prompt', { name: primary.name })), {
        reply_markup: { inline_keyboard: buildPromptKeyboard(primary.id, token) },
      });
    } catch (err) {
      console.error('plan_flow start error', err);
    }
  }

  async function confirm(ctx, objectId, token = null) {
    const tgUserId = ctx.from?.id;
    if (!tgUserId || !objectId) {
      await safeAnswer(ctx, 'plan_object_no_context', true);
      await replyUserError(ctx, deriveMissingContextCode(token));
      return;
    }
    const { diagnosis, expired } = await resolvePlanSession(ctx, token, {
      consume: true,
      step: 'finalize',
    });
    if (!diagnosis) {
      console.warn('plan_flow.confirm.missing_diagnosis', { userId: tgUserId, objectId, token });
      await safeAnswer(ctx, expired ? 'plan_session_expired' : 'plan_object_no_context', true);
      await replyUserError(ctx, expired ? 'SESSION_EXPIRED' : token ? 'BUTTON_EXPIRED' : 'NO_RECENT_DIAGNOSIS');
      return;
    }
    console.info('plan_flow.confirm', { userId: tgUserId, objectId, token });
    await finalizePlan(ctx, tgUserId, objectId, diagnosis);
  }

  async function choose(ctx, token = null) {
    const tgUserId = ctx.from?.id;
    if (!tgUserId) {
      await safeAnswer(ctx, 'plan_object_no_context', true);
      await replyUserError(ctx, deriveMissingContextCode(token));
      return;
    }
    const { diagnosis, session, expired } = await resolvePlanSession(ctx, token, {
      step: 'choose_object',
    });
    if (!diagnosis || !session) {
      console.warn('plan_flow.choose.missing_session', {
        userId: tgUserId,
        token,
        expired,
        hasDiagnosis: Boolean(diagnosis),
        hasSession: Boolean(session),
      });
      await safeAnswer(ctx, expired ? 'plan_session_expired' : 'plan_object_no_context', true);
      await replyUserError(ctx, expired ? 'SESSION_EXPIRED' : 'BUTTON_EXPIRED');
      return;
    }
    try {
      console.info('plan_flow.choose', {
        userId: tgUserId,
        token: session.token,
        hasDiagnosis: true,
      });
      const user = await db.ensureUser(tgUserId);
      const { objects } = await ensurePrimaryObject(user, diagnosis);
      const keyboard = buildChooseKeyboard(objects, session.token);
      if (!keyboard.length) {
        await ctx.reply(msg('plan_object_no_objects'));
        return;
      }
      await ctx.reply(formatStepPrompt('plan_step_choose_object', msg('plan_object_choose_prompt')), {
        reply_markup: { inline_keyboard: keyboard },
      });
      await ctx.answerCbQuery();
    } catch (err) {
      console.error('plan_flow choose error', err);
      await safeAnswer(ctx, 'plan_object_error', true);
    }
  }

  async function pick(ctx, objectId, token = null) {
    const tgUserId = ctx.from?.id;
    if (!tgUserId || !objectId) {
      await safeAnswer(ctx, 'plan_object_no_context', true);
      await replyUserError(ctx, deriveMissingContextCode(token));
      return;
    }
    const { diagnosis, session, expired } = await resolvePlanSession(ctx, token, {
      step: 'confirm_object',
    });
    if (!diagnosis || !session) {
      console.warn('plan_flow.pick.missing_session', {
        userId: tgUserId,
        objectId,
        token,
        expired,
        hasDiagnosis: Boolean(diagnosis),
        hasSession: Boolean(session),
      });
      await safeAnswer(ctx, expired ? 'plan_session_expired' : 'plan_object_no_context', true);
      await replyUserError(ctx, expired ? 'SESSION_EXPIRED' : 'BUTTON_EXPIRED');
      return;
    }
    console.info('plan_flow.pick', {
      userId: tgUserId,
      objectId,
      token,
      sessionId: session.id,
    });
    try {
      const user = await db.ensureUser(tgUserId);
      const object = await db.getObjectById(objectId);
      const requesterKey = normalizeUserKey(user?.id);
      const ownerKey = normalizeUserKey(object?.user_id);
      if (!object || !requesterKey || requesterKey !== ownerKey) {
        console.warn('plan_flow.pick.object_mismatch', {
          userId: tgUserId,
          objectId,
          requesterKey,
          ownerKey,
          found: Boolean(object),
        });
        await replyUserError(ctx, 'OBJECT_NOT_OWNED');
        return;
      }
      if (typeof db.updateUserLastObject === 'function') {
        try {
          await db.updateUserLastObject(user.id, object.id);
        } catch (err) {
          console.error('plan_flow.pick.update_last_object_failed', err);
        }
      }
      await db.updatePlanSession(session.id, {
        objectId: object.id,
        currentStep: 'confirm_object',
        state: { ...(session.state || {}), selected_object_id: object.id },
      });
      const prompt = await ctx.reply(msg('plan_step_choose_selected', { name: object.name }), {
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: msg('plan_object_continue'),
                callback_data: buildConfirmData(object.id, session.token),
              },
            ],
            [
              {
                text: msg('plan_object_choose_other'),
                callback_data: buildChooseData(session.token),
              },
            ],
            [{ text: msg('plan_step_cancel'), callback_data: buildCancelData(session.token) }],
          ],
        },
      });
      console.info('plan_flow.pick.prompt_sent', {
        userId: tgUserId,
        objectId: object.id,
        token: session.token,
        messageId: prompt?.message_id ?? null,
      });
      await ctx.answerCbQuery();
    } catch (err) {
      console.error('plan_flow pick error', err);
      await safeAnswer(ctx, 'plan_object_error', true);
    }
  }

  async function create(ctx, token = null) {
    const tgUserId = ctx.from?.id;
    if (!tgUserId) {
      await safeAnswer(ctx, 'plan_object_no_context', true);
      await replyUserError(ctx, deriveMissingContextCode(token));
      return;
    }
    const { diagnosis, expired } = await resolvePlanSession(ctx, token, {
      consume: true,
      step: 'create_object',
    });
    if (!diagnosis) {
      console.warn('plan_flow.create.missing_diagnosis', { userId: tgUserId, token });
      await safeAnswer(ctx, expired ? 'plan_session_expired' : 'plan_object_no_context', true);
      await replyUserError(ctx, expired ? 'SESSION_EXPIRED' : 'BUTTON_EXPIRED');
      return;
    }
    try {
      console.info('plan_flow.create', { userId: tgUserId, token });
      const user = await db.ensureUser(tgUserId);
      const name = `${deriveObjectName(diagnosis)} #${Math.floor(Date.now() / 1000)}`;
      const object = await db.createObject(user.id, {
        name,
        type: diagnosis?.crop || null,
        locationTag: diagnosis?.region || null,
        meta: { source: 'button' },
      });
      await db.updateUserLastObject(user.id, object.id);
      await finalizePlan(ctx, tgUserId, object.id, diagnosis);
    } catch (err) {
      console.error('plan_flow create error', err);
      await ctx.reply(msg('plan_object_error'));
    }
  }

  async function finalizePlan(ctx, userId, objectId, diagnosis) {
    try {
      const tgUserId = ctx.from?.id || null;
      console.info('plan_flow.finalize.begin', {
        userId,
        tgUserId,
        objectId,
        planKind: diagnosis?.plan_kind || null,
      });
      const user = await db.ensureUser(userId);
      const object = await db.getObjectById(objectId);
      const requesterKey = normalizeUserKey(user?.id);
      const ownerKey = normalizeUserKey(object?.user_id);
      if (!object || !requesterKey || requesterKey !== ownerKey) {
        console.warn('plan_flow.finalize.object_mismatch', {
          userId,
          tgUserId,
          userDbId: user?.id ?? null,
          objectId,
          found: Boolean(object),
          ownerId: object?.user_id ?? null,
        });
        await safeAnswer(ctx, 'plan_object_not_found', true);
        await replyUserError(ctx, 'OBJECT_NOT_OWNED');
        return;
      }
      const chatId = resolveChatId(ctx);
      if (!chatId) {
        console.warn('plan_flow.finalize.no_chat', { userId, tgUserId, objectId });
        await safeAnswer(ctx, 'plan_object_error', true);
        return;
      }
      const caseRow = await db.createCase({
        user_id: user.id,
        object_id: object.id,
        crop: diagnosis.crop,
        disease: diagnosis.disease,
        confidence: diagnosis.confidence,
        raw_ai: diagnosis,
      });
      const planKind = normalizePlanKind(diagnosis?.plan_kind);
      diagnosis.plan_kind = planKind;
      const duplicatePlan =
        typeof db.findPlanByHash === 'function'
          ? await db.findPlanByHash({
              userId: user.id,
              objectId: object.id,
              hash: diagnosis.plan_hash || null,
            })
          : null;
      if (duplicatePlan) {
        console.info('plan_flow.finalize.duplicate', {
          userId: user.id,
          planId: duplicatePlan.id,
          objectId: object.id,
        });
        await safeAnswer(ctx, 'plan_object_duplicate');
        await ctx.reply(msg('plan_step_plan_intro', { name: object.name }));
        await planWizard.showPlanTable(chatId, duplicatePlan.id, {
          userId: user.id,
          diffAgainst: planKind === 'PLAN_UPDATE' ? 'accepted' : null,
        });
        notifyWatchers({
          type: 'plan_created',
          userId: user.id,
          planId: duplicatePlan.id,
          objectId: object.id,
          chatId,
        });
        return;
      }
      const previousPlan =
        planKind === 'PLAN_UPDATE' && typeof db.findLatestPlanByObject === 'function'
          ? await db.findLatestPlanByObject(object.id, ['accepted', 'scheduled'])
          : null;
      const version =
        planKind === 'PLAN_UPDATE' && previousPlan
          ? Number(previousPlan.version || 1) + 1
          : 1;
      const meta = buildPlanMetadata(diagnosis);
      const plan = await db.createPlan({
        user_id: user.id,
        object_id: object.id,
        case_id: caseRow.id,
        title: buildPlanTitle(object, diagnosis),
        status: 'proposed',
        version,
        hash: meta.hash,
        source: meta.source,
        payload: meta.payload,
        plan_kind: meta.plan_kind,
        plan_errors: meta.plan_errors,
      });
      if (diagnosis?.recent_diagnosis_id && typeof db.linkRecentDiagnosisToPlan === 'function') {
        try {
          await db.linkRecentDiagnosisToPlan({
            diagnosisId: diagnosis.recent_diagnosis_id,
            objectId: object.id,
            caseId: caseRow.id,
            planId: plan.id,
          });
        } catch (err) {
          console.error('recent_diagnosis link failed', err);
        }
      }
      const stageResult = await collectStageDefinitions(catalog, diagnosis, object);
      const stageDefs = stageResult?.stages || [];
      const fallbackNotices = stageResult?.fallbackNotices || [];
      await logFunnelEvent(db, {
        event: 'object_selected',
        userId: user.id,
        objectId: object.id,
        planId: plan.id,
        data: {
          plan_kind: planKind,
          diagnosis_hash: diagnosis?.plan_hash || null,
        },
      });
      console.info('plan_flow.plan_created', {
        userId: user.id,
        tgUserId,
        planId: plan.id,
        planKind,
        objectId: object.id,
        hasMachinePlan: Boolean(diagnosis.plan_machine),
        stageCount: stageDefs.length,
      });
      if (!stageDefs.length) {
        console.warn('plan_flow.plan_missing_stages', {
          userId: user.id,
          tgUserId,
          planId: plan.id,
          planKind,
          objectId: object.id,
        });
        await ctx.reply(msg('plan_object_error'));
        return;
      }
      if (fallbackNotices.length) {
        const stageTitles = [
          ...new Set(
            fallbackNotices
              .map((entry) => (entry?.stageTitle ? String(entry.stageTitle).trim() : ''))
              .filter(Boolean),
          ),
        ];
        if (stageTitles.length) {
          const stageList = stageTitles.map((title) => `• ${title}`).join('\n');
          await ctx.reply(msg('plan_stage_fallback_notice', { stages: stageList }));
        }
      }
      await db.createStagesWithOptions(plan.id, stageDefs);
      const responseKey =
        planKind === 'PLAN_UPDATE' ? 'plan_object_saved_update' : 'plan_object_saved';
      await safeAnswer(ctx, responseKey);
      const planSession = await persistPlanSession({
        user,
        object,
        plan,
        diagnosis,
      });
      const nav = buildStepControls(planSession?.token);
      await ctx.reply(msg('plan_step_plan_intro', { name: object.name }), {
        reply_markup: nav.length ? { inline_keyboard: nav } : undefined,
      });
      await planWizard.showPlanTable(chatId, plan.id, {
        userId: user.id,
        diffAgainst: planKind === 'PLAN_UPDATE' ? 'accepted' : null,
      });
      notifyWatchers({
        type: 'plan_created',
        userId: user.id,
        tgUserId,
        planId: plan.id,
        objectId: object.id,
        chatId,
      });
    } catch (err) {
      console.error('plan_flow finalize error', err);
      await ctx.reply(msg('plan_object_error'));
    }
  }

  async function safeAnswer(ctx, key, alert = false) {
    if (typeof ctx.answerCbQuery === 'function') {
      try {
        await ctx.answerCbQuery(msg(key), { show_alert: alert });
      } catch {
        // ignore
      }
    } else {
      await ctx.reply(msg(key));
    }
  }

  async function persistPlanSession({ user, object, plan, diagnosis }) {
    if (!user?.id || !plan?.id || !diagnosis) return null;
    const token = generateToken();
    try {
      await sessionStore.deleteByPlan(user.id, plan.id);
      const record = await sessionStore.upsert(user, {
        token,
        diagnosisPayload: diagnosis,
        recentDiagnosisId: diagnosis.recent_diagnosis_id || null,
        objectId: object?.id || null,
        planId: plan.id,
        currentStep: 'time_idle',
        state: {
          mode: 'time_idle',
          planId: plan.id,
          objectId: object?.id || null,
        },
        ttlHours: 72,
      });
      return record;
    } catch (err) {
      console.error('plan_flow.persist_session error', err);
      return null;
    }
  }

  return {
    start,
    confirm,
    choose,
    pick,
    create,
    cancelSession,
    restartSession,
    attachObjectChips,
    watch: (fn) => watchers.add(fn),
  };
}

function deriveObjectName(data) {
  return data?.crop_ru || data?.crop || msg('object.default_name');
}

function buildConfirmData(objectId, token) {
  return token ? `plan_obj_confirm|${objectId}|${token}` : `plan_obj_confirm|${objectId}`;
}

function buildPickData(objectId, token) {
  return token ? `plan_obj_pick|${objectId}|${token}` : `plan_obj_pick|${objectId}`;
}

function buildChooseData(token) {
  return token ? `plan_obj_choose|${token}` : 'plan_obj_choose';
}

function buildCreateData(token) {
  return token ? `plan_obj_create|${token}` : 'plan_obj_create';
}

function buildBackData(token) {
  return token ? `plan_step_back|${token}` : 'plan_step_back';
}

function buildCancelData(token) {
  return token ? `plan_step_cancel|${token}` : 'plan_step_cancel';
}

function chunkChips(items, size) {
  const rows = [];
  for (let i = 0; i < items.length; i += size) {
    rows.push(items.slice(i, i + size));
  }
  return rows;
}

function buildPlanTitle(object, data) {
  const crop = data?.crop_ru || data?.crop || object?.name || msg('object.default_name');
  const disease = data?.disease_name_ru || data?.disease || msg('diagnosis.fallback_disease');
  return `${crop} — ${disease}`;
}

async function collectStageDefinitions(catalog, data, object) {
  const productRulesEnabled = catalog?.productRulesEnabled !== false;
  if (data?.plan_machine?.stages?.length) {
    return {
      stages: buildDefinitionsFromMachinePlan(data),
      fallbackNotices: [],
    };
  }
  const fallbackNotices = [];
  try {
    const stages = (await catalog.suggestStages({
      crop: data?.crop,
      disease: data?.disease,
    })) || [];
    const region = object?.location_tag || null;
    const defs = [];
    for (const [idx, stage] of stages.entries()) {
      const resolvedTitle = resolveStageTitle(stage, idx);
      let options = await catalog.suggestOptions({
        crop: data?.crop,
        disease: data?.disease,
        region,
        stageKind: stage.kind,
        limit: stage.meta?.option_limit || 3,
      });
      if ((!options || !options.length) && stage.kind !== 'trigger') {
        const fallback = buildFallbackOptionFromDiagnosis(stage, data);
        if (fallback) {
          const reason = productRulesEnabled ? 'catalog_empty' : 'ai_only_mode';
          console.info('plan_flow.stage_fallback_option', {
            planKind: data?.plan_kind || null,
            stageTitle: resolvedTitle,
            reason,
          });
          if (productRulesEnabled) {
            fallbackNotices.push({
              stageTitle: resolvedTitle,
              reason: 'catalog_empty',
            });
          }
          options = [fallback];
        }
      }
      defs.push({
        title: resolvedTitle,
        kind: stage.kind,
        note: stage.note,
        phi_days: stage.phi_days,
        meta: stage.meta,
        options: (options || []).map((opt) => ({
          product: opt.product,
          ai: opt.ai,
          dose_value: opt.dose_value,
          dose_unit: opt.dose_unit,
          method: opt.meta?.method || null,
          meta: { ...opt.meta, stage_kind: stage.kind },
        })),
      });
    }
    return { stages: defs, fallbackNotices };
  } catch (err) {
    console.error('collectStageDefinitions error', err);
    return { stages: [], fallbackNotices };
  }
}

function resolveStageTitle(stage, index = null) {
  const rawTitle = typeof stage?.title === 'string' ? stage.title.trim() : '';
  if (rawTitle) return rawTitle;
  const defaultLabel = msg('plan_stage_default') || 'Этап';
  if (Number.isInteger(index)) {
    return `${defaultLabel} ${index + 1}`;
  }
  return defaultLabel;
}

function buildDefinitionsFromMachinePlan(data) {
  const machine = data.plan_machine;
  const stages = Array.isArray(machine?.stages) ? machine.stages : [];
  const defaultStageLabel = msg('plan_stage_default') || 'Этап';
  const defaultOptionLabel = msg('plan_option_fallback') || 'Вариант';
  return stages.slice(0, 5).map((stage, idx) => {
    const safeTitle = typeof stage.name === 'string' && stage.name.trim()
      ? stage.name.trim()
      : `${defaultStageLabel} ${idx + 1}`;
    const options = Array.isArray(stage.options) ? stage.options : [];
    const firstPhi = options.find((opt) => Number.isFinite(opt?.phi_days));
    return {
      title: safeTitle,
      kind: stage.kind || stage.meta?.kind || 'season',
      note: stage.notes || stage.trigger || null,
      phi_days: typeof firstPhi?.phi_days === 'number' ? firstPhi.phi_days : null,
      meta: {
        source: 'ai',
        trigger: stage.trigger || null,
        ai_stage_index: idx,
        plan_hash: data.plan_hash || null,
      },
      options: options.slice(0, 3).map((opt) => ({
        product: opt.product_name || opt.product_code || defaultOptionLabel,
        ai: opt.ai || null,
        dose_value: Number.isFinite(opt.dose_value) ? opt.dose_value : null,
        dose_unit: opt.dose_unit || null,
        method: opt.method || null,
        meta: {
          source: 'ai',
          product_code: opt.product_code || null,
          notes: opt.notes || null,
          needs_review: Boolean(opt.needs_review),
          phi_days: opt.phi_days ?? null,
        },
      })),
    };
  });
}

function buildFallbackOptionFromDiagnosis(stage, diagnosis) {
  const treatment = diagnosis?.treatment_plan || diagnosis?.treatment_plan_ru || null;
  const product =
    treatment?.product ||
    treatment?.substance ||
    treatment?.substance_ru ||
    stage?.title ||
    msg('plan_option_fallback');
  const doseValue =
    Number.isFinite(treatment?.dosage_value) && treatment.dosage_value > 0
      ? treatment.dosage_value
      : null;
  const doseUnit = treatment?.dosage_unit || treatment?.dosage || null;
  const method = treatment?.method || stage?.note || null;
  const phiDays =
    Number.isFinite(treatment?.phi_days) && treatment.phi_days >= 0
      ? treatment.phi_days
      : null;
  return {
    product,
    ai: treatment?.substance || null,
    dose_value: doseValue,
    dose_unit: doseUnit,
    method,
    meta: {
      source: 'diagnosis_fallback',
      notes: treatment?.safety_note || treatment?.notes || null,
      safety: treatment?.safety || null,
      phi_days: phiDays,
      fallback: true,
    },
  };
}

function buildPlanMetadata(diagnosis) {
  const planKind = normalizePlanKind(diagnosis?.plan_kind);
  if (diagnosis?.plan_machine) {
    return {
      hash: diagnosis.plan_hash || null,
      source: 'ai',
      payload: diagnosis.plan_machine,
      plan_kind: planKind,
      plan_errors: diagnosis.plan_validation_errors || null,
    };
  }
  return {
    hash: null,
    source: 'catalog',
    payload: null,
    plan_kind: planKind,
    plan_errors: null,
  };
}

function normalizePlanKind(rawKind) {
  if (!rawKind) return PLAN_KIND_DEFAULT;
  const upper = String(rawKind).trim().toUpperCase();
  if (PLAN_KIND_SKIP.has(upper)) return upper;
  if (PLAN_KIND_ALLOWED.has(upper)) return upper;
  return PLAN_KIND_DEFAULT;
}

function resolveChatId(ctx) {
  return ctx?.chat?.id ?? ctx?.from?.id ?? null;
}

function normalizeUserKey(value) {
  if (value === undefined || value === null) return null;
  return String(value);
}

function buildChipsInlineKeyboard(objects, activeId, token) {
  if (!objects?.length) return null;
  const chips = objects.slice(0, 6).map((obj) => ({
    text: obj.id === activeId ? `• ${obj.name}` : obj.name,
    callback_data: buildPickData(obj.id, token || null),
  }));
  const rows = chunkChips(chips, ROW_SIZE);
  rows.push([{ text: msg('plan_step_cancel'), callback_data: buildCancelData(token) }]);
  return { inline_keyboard: rows };
}

function chunkChips(items, size) {
  const rows = [];
  for (let i = 0; i < items.length; i += size) {
    rows.push(items.slice(i, i + size));
  }
  return rows;
}

function deriveMissingContextCode(token) {
  return token ? 'BUTTON_EXPIRED' : 'NO_RECENT_DIAGNOSIS';
}

function createSessionStore({ db, planSessions }) {
  const hasApi = Boolean(planSessions);

  function normalizeSession(record) {
    if (!record) return null;
    if ('diagnosis_payload' in record) {
      return {
        ...record,
        state: ensureObject(record.state),
      };
    }
    return {
      id: record.id,
      user_id: record.user_id,
      token: record.token,
      diagnosis_payload: record.diagnosis || {},
      recent_diagnosis_id: record.recent_diagnosis_id ?? null,
      object_id: record.object_id ?? null,
      plan_id: record.plan_id ?? null,
      current_step: record.current_step,
      state: ensureObject(record.state),
      expires_at: record.expires_at,
    };
  }

  function ensureObject(value) {
    if (value && typeof value === 'object') return value;
    return {};
  }

  async function deleteForUser(userId) {
    if (!userId) return;
    try {
      if (hasApi) {
        await planSessions.deleteAll(userId);
      } else if (typeof db.deletePlanSessionsForUser === 'function') {
        await db.deletePlanSessionsForUser(userId);
      }
    } catch (err) {
      console.error('plan_flow.session_cleanup_failed', err);
    }
  }

  async function upsert(user, payload) {
    if (!user?.id || !payload?.token) return null;
    try {
      if (hasApi) {
        const record = await planSessions.upsert(user.id, {
          token: payload.token,
          diagnosis: payload.diagnosisPayload,
          current_step: payload.currentStep,
          state: payload.state || {},
          recent_diagnosis_id: payload.recentDiagnosisId ?? null,
          object_id: payload.objectId ?? null,
          plan_id: payload.planId ?? null,
          ttl_hours: payload.ttlHours ?? null,
        });
        return normalizeSession(record);
      }
      if (typeof db.createPlanSession !== 'function') return null;
      const record = await db.createPlanSession({
        userId: user.id,
        token: payload.token,
        diagnosisPayload: payload.diagnosisPayload,
        recentDiagnosisId: payload.recentDiagnosisId ?? null,
        objectId: payload.objectId ?? null,
        planId: payload.planId ?? null,
        currentStep: payload.currentStep,
        state: payload.state || {},
        ttlHours: payload.ttlHours,
      });
      return normalizeSession(record);
    } catch (err) {
      console.error('plan_flow.session_upsert_failed', err);
      return null;
    }
  }

  async function fetchLatest(userId) {
    if (!userId) return null;
    try {
      if (hasApi) {
        const record = await planSessions.fetchLatest(userId, { includeExpired: true });
        return normalizeSession(record);
      }
      if (typeof db.getLatestPlanSessionForUser !== 'function') return null;
      return normalizeSession(await db.getLatestPlanSessionForUser(userId));
    } catch (err) {
      if (err.status === 404) return null;
      console.error('plan_flow.session_fetch_failed', err);
      return null;
    }
  }

  async function fetchByToken(userId, token) {
    if (!userId) return null;
    if (!token) return null;
    try {
      if (hasApi) {
        const record = await planSessions.fetchByToken(userId, token, { includeExpired: true });
        return normalizeSession(record);
      }
      if (typeof db.getPlanSessionByToken !== 'function') return null;
      return normalizeSession(await db.getPlanSessionByToken(token));
    } catch (err) {
      if (err.status === 404) return null;
      console.error('plan_flow.session_fetch_failed', err);
      return null;
    }
  }

  async function deleteSession(session) {
    if (!session?.token || !session?.user_id) return;
    try {
      if (hasApi) {
        await planSessions.deleteByToken(session.user_id, session.token);
      } else if (typeof db.deletePlanSession === 'function') {
        await db.deletePlanSession(session.id);
      }
    } catch (err) {
      console.error('plan_flow.session_delete_failed', err);
    }
  }

  async function updateSession(session, patch) {
    if (!session?.id || !session?.user_id) return;
    const payload = {
      currentStep: patch.currentStep,
      state: patch.state,
      planId: patch.planId,
      objectId: patch.objectId,
      ttlHours: patch.ttlHours,
      diagnosisPayload: patch.diagnosisPayload,
      recentDiagnosisId: patch.recentDiagnosisId,
    };
    try {
      if (hasApi) {
        await planSessions.patch(session.user_id, session.id, {
          current_step: payload.currentStep,
          state: payload.state,
          plan_id: payload.planId,
          object_id: payload.objectId,
          ttl_hours: payload.ttlHours,
          diagnosis: payload.diagnosisPayload,
          recent_diagnosis_id: payload.recentDiagnosisId,
        });
      } else if (typeof db.updatePlanSession === 'function') {
        await db.updatePlanSession(session.id, {
          currentStep: payload.currentStep,
          state: payload.state,
          planId: payload.planId,
          objectId: payload.objectId,
          ttlHours: payload.ttlHours,
          diagnosisPayload: payload.diagnosisPayload,
          recentDiagnosisId: payload.recentDiagnosisId,
        });
      }
    } catch (err) {
      console.error('plan_flow.session_update_failed', err);
    }
  }

  async function deleteByPlan(userId, planId) {
    if (!userId || !planId) return;
    try {
      if (hasApi) {
        await planSessions.deleteByPlan(userId, planId);
      } else if (typeof db.deletePlanSessionsByPlan === 'function') {
        await db.deletePlanSessionsByPlan(planId);
      }
    } catch (err) {
      console.error('plan_flow.session_plan_cleanup_failed', err);
    }
  }

  return {
    deleteForUser,
    upsert,
    fetchLatest,
    fetchByToken,
    deleteSession,
    updateSession,
    deleteByPlan,
  };
}

module.exports = { createPlanFlow };
