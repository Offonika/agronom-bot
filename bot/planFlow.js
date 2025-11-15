'use strict';

const { msg } = require('./utils');
const { logFunnelEvent } = require('./funnel');
const { LOW_CONFIDENCE_THRESHOLD } = require('./messageFormatters/diagnosisMessage');
const { replyUserError } = require('./userErrors');

const PLAN_KIND_DEFAULT = 'PLAN_NEW';
const ROW_SIZE = 3;
const PLAN_KIND_SKIP = new Set(['QNA', 'FAQ']);
const PLAN_KIND_ALLOWED = new Set(['PLAN_NEW', 'PLAN_UPDATE']);

function createPlanFlow({ db, catalog, planWizard }) {
  if (!db || !catalog || !planWizard) {
    throw new Error('planFlow requires db, catalog and planWizard');
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
    if (typeof db.purgeExpiredPlanSessions === 'function') {
      try {
        await db.purgeExpiredPlanSessions();
      } catch (err) {
        console.error('plan_flow session purge failed', err);
      }
    }
    if (typeof db.deletePlanSessionsForUser === 'function') {
      try {
        await db.deletePlanSessionsForUser(user.id);
      } catch (err) {
        console.error('plan_flow session cleanup failed', err);
      }
    }
    if (typeof db.createPlanSession !== 'function') return null;
    return db.createPlanSession({
      userId: user.id,
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
    if (token && typeof db.getPlanSessionByToken === 'function') {
      session = await db.getPlanSessionByToken(token);
    } else if (typeof db.getLatestPlanSessionForUser === 'function') {
      session = await db.getLatestPlanSessionForUser(user.id);
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
      if (typeof db.deletePlanSession === 'function') {
        await db.deletePlanSession(session.id);
      }
      return { diagnosis: null, session: null, user, expired: true };
    }
    const payload = session.diagnosis_payload || {};
    const diagnosis = {
      ...payload,
      recent_diagnosis_id:
        payload.recent_diagnosis_id ?? session.recent_diagnosis_id ?? null,
    };
    if (opts.consume && typeof db.deletePlanSession === 'function') {
      await db.deletePlanSession(session.id);
    } else if (typeof db.updatePlanSession === 'function') {
      await db.updatePlanSession(session.id, { currentStep: opts.step || session.current_step });
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
    return { primary, objects };
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
    if (PLAN_KIND_SKIP.has(planKind) || !PLAN_KIND_ALLOWED.has(planKind)) {
      console.info('plan_flow.start.skipped_kind', { userId: ctx.from.id, planKind });
      return;
    }
    const payload = { ...diagnosis, plan_kind: planKind };
    try {
      const user = await db.ensureUser(ctx.from.id);
      const { primary, objects } = await ensurePrimaryObject(user, payload);
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
          await finalizePlan(ctx, user.id, primary.id, payload);
        }
        return;
      }
      const token = generateToken();
      const session = await createPlanSessionRecord(user, payload, token);
      if (!session) return;
      console.info('plan_flow.start', {
        userId: user.id,
        planKind,
        objectId: primary.id,
        token,
        diagnosisHash: payload.plan_hash || null,
      });
      const chips = buildChipsInlineKeyboard(objects, user.last_object_id || primary.id, token);
      if (chips) {
        console.info('plan_flow.chips_prompt', {
          userId: user.id,
          token,
          objectCount: objects.length,
        });
        await ctx.reply(msg('plan_step_choose_object'), { reply_markup: chips });
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
    const userId = ctx.from?.id;
    if (!userId || !objectId) {
      await safeAnswer(ctx, 'plan_object_no_context', true);
      return;
    }
    const { diagnosis, expired } = await resolvePlanSession(ctx, token, {
      consume: true,
      step: 'finalize',
    });
    if (!diagnosis) {
      console.warn('plan_flow.confirm.missing_diagnosis', { userId, objectId, token });
      await safeAnswer(ctx, expired ? 'plan_session_expired' : 'plan_object_no_context', true);
      await replyUserError(ctx, expired ? 'SESSION_EXPIRED' : token ? 'BUTTON_EXPIRED' : 'NO_RECENT_DIAGNOSIS');
      return;
    }
    console.info('plan_flow.confirm', { userId, objectId, token });
    await finalizePlan(ctx, userId, objectId, diagnosis);
  }

  async function choose(ctx, token = null) {
    const userId = ctx.from?.id;
    if (!userId) {
      await safeAnswer(ctx, 'plan_object_no_context', true);
      return;
    }
    const { diagnosis, session, expired } = await resolvePlanSession(ctx, token, {
      step: 'choose_object',
    });
    if (!diagnosis || !session) {
      console.warn('plan_flow.choose.missing_session', {
        userId,
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
      console.info('plan_flow.choose', { userId, token: session.token, hasDiagnosis: true });
      const user = await db.ensureUser(userId);
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
    const userId = ctx.from?.id;
    if (!userId || !objectId) {
      await safeAnswer(ctx, 'plan_object_no_context', true);
      return;
    }
    const { diagnosis, session, expired } = await resolvePlanSession(ctx, token, {
      step: 'confirm_object',
    });
    if (!diagnosis || !session) {
      console.warn('plan_flow.pick.missing_session', {
        userId,
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
      userId,
      objectId,
      token,
      sessionId: session.id,
    });
    try {
      const user = await db.ensureUser(userId);
      const object = await db.getObjectById(objectId);
      const requesterKey = normalizeUserKey(user?.id);
      const ownerKey = normalizeUserKey(object?.user_id);
      if (!object || !requesterKey || requesterKey !== ownerKey) {
        console.warn('plan_flow.pick.object_mismatch', {
          userId,
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
        userId,
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
    const userId = ctx.from?.id;
    if (!userId) {
      await safeAnswer(ctx, 'plan_object_no_context', true);
      return;
    }
    const { diagnosis, expired } = await resolvePlanSession(ctx, token, {
      consume: true,
      step: 'create_object',
    });
    if (!diagnosis) {
      console.warn('plan_flow.create.missing_diagnosis', { userId, token });
      await safeAnswer(ctx, expired ? 'plan_session_expired' : 'plan_object_no_context', true);
      await replyUserError(ctx, expired ? 'SESSION_EXPIRED' : 'BUTTON_EXPIRED');
      return;
    }
    try {
      console.info('plan_flow.create', { userId, token });
      const user = await db.ensureUser(userId);
      const name = `${deriveObjectName(diagnosis)} #${Math.floor(Date.now() / 1000)}`;
      const object = await db.createObject(user.id, {
        name,
        type: diagnosis?.crop || null,
        locationTag: diagnosis?.region || null,
        meta: { source: 'button' },
      });
      await db.updateUserLastObject(user.id, object.id);
      await finalizePlan(ctx, userId, object.id, diagnosis);
    } catch (err) {
      console.error('plan_flow create error', err);
      await ctx.reply(msg('plan_object_error'));
    }
  }

  async function finalizePlan(ctx, userId, objectId, diagnosis) {
    try {
      console.info('plan_flow.finalize.begin', {
        userId,
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
        console.warn('plan_flow.finalize.no_chat', { userId, objectId });
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
      const stageDefs = await collectStageDefinitions(catalog, diagnosis, object);
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
        planId: plan.id,
        planKind,
        objectId: object.id,
        hasMachinePlan: Boolean(diagnosis.plan_machine),
        stageCount: stageDefs.length,
      });
      if (!stageDefs.length) {
        console.warn('plan_flow.plan_missing_stages', {
          userId: user.id,
          planId: plan.id,
          planKind,
          objectId: object.id,
        });
        await ctx.reply(msg('plan_object_error'));
        return;
      }
      await db.createStagesWithOptions(plan.id, stageDefs);
      const responseKey =
        planKind === 'PLAN_UPDATE' ? 'plan_object_saved_update' : 'plan_object_saved';
      await safeAnswer(ctx, responseKey);
      await ctx.reply(msg('plan_step_plan_intro', { name: object.name }));
      await planWizard.showPlanTable(chatId, plan.id, {
        userId: user.id,
        diffAgainst: planKind === 'PLAN_UPDATE' ? 'accepted' : null,
      });
      await persistPlanSession({
        user,
        object,
        plan,
        diagnosis,
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
  if (!user?.id || !plan?.id || !diagnosis) return;
  if (!db?.createPlanSession) return;
  const token = generateToken();
  try {
    if (typeof db.deletePlanSessionsByPlan === 'function') {
      await db.deletePlanSessionsByPlan(plan.id);
    }
    await db.createPlanSession({
      userId: user.id,
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
  } catch (err) {
    console.error('plan_flow.persist_session error', err);
  }
}

  return {
    start,
    confirm,
    choose,
    pick,
    create,
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
  if (data?.plan_machine?.stages?.length) {
    return buildDefinitionsFromMachinePlan(data);
  }
  try {
    const stages = (await catalog.suggestStages({
      crop: data?.crop,
      disease: data?.disease,
    })) || [];
    const region = object?.location_tag || null;
    const defs = [];
    for (const stage of stages) {
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
          console.info('plan_flow.stage_fallback_option', {
            planKind: data?.plan_kind || null,
            stageTitle: stage.title,
            reason: 'catalog_empty',
          });
          options = [fallback];
        }
      }
      defs.push({
        title: stage.title,
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
    return defs;
  } catch (err) {
    console.error('collectStageDefinitions error', err);
    return [];
  }
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

module.exports = { createPlanFlow };
