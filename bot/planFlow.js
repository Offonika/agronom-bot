'use strict';

const { msg } = require('./utils');
const { LOW_CONFIDENCE_THRESHOLD } = require('./messageFormatters/diagnosisMessage');

const MAX_PENDING_PLANS = 200;

function createPlanFlow({ db, catalog, planWizard }) {
  if (!db || !catalog || !planWizard) {
    throw new Error('planFlow requires db, catalog and planWizard');
  }

  const pendingPlans = new Map();

  function cleanupPending() {
    if (pendingPlans.size < MAX_PENDING_PLANS) return;
    const oldestKey = pendingPlans.keys().next().value;
    if (oldestKey !== undefined) pendingPlans.delete(oldestKey);
  }

  function storePending(userId, diagnosis) {
    if (!userId || !diagnosis) return;
    cleanupPending();
    pendingPlans.set(userId, { diagnosis, ts: Date.now() });
  }

  function consumePending(userId) {
    if (!userId) return null;
    const payload = pendingPlans.get(userId);
    pendingPlans.delete(userId);
    return payload?.diagnosis || null;
  }

  function peekPending(userId) {
    return pendingPlans.get(userId)?.diagnosis || null;
  }

  function buildPromptKeyboard(objectId) {
    return [
      [{ text: msg('plan_object_yes'), callback_data: `plan_obj_confirm|${objectId}` }],
      [{ text: msg('plan_object_choose'), callback_data: 'plan_obj_choose' }],
      [{ text: msg('plan_object_create'), callback_data: 'plan_obj_create' }],
    ];
  }

  function buildChooseKeyboard(objects) {
    if (!objects.length) return [];
    const buttons = objects.slice(0, 6).map((obj) => [
      { text: obj.name, callback_data: `plan_obj_pick|${obj.id}` },
    ]);
    return buttons;
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

  async function start(ctx, diagnosis) {
    if (!ctx?.from?.id || (diagnosis?.confidence ?? 0) < LOW_CONFIDENCE_THRESHOLD) return;
    try {
      const user = await db.ensureUser(ctx.from.id);
      const { primary } = await ensurePrimaryObject(user, diagnosis);
      storePending(user.id, diagnosis);
      await ctx.reply(msg('plan_object_prompt', { name: primary.name }), {
        reply_markup: { inline_keyboard: buildPromptKeyboard(primary.id) },
      });
    } catch (err) {
      console.error('plan_flow start error', err);
    }
  }

  async function confirm(ctx, objectId) {
    const userId = ctx.from?.id;
    if (!userId || !objectId) {
      await safeAnswer(ctx, 'plan_object_no_context', true);
      return;
    }
    const diagnosis = consumePending(userId);
    if (!diagnosis) {
      await safeAnswer(ctx, 'plan_object_no_context', true);
      return;
    }
    await finalizePlan(ctx, userId, objectId, diagnosis);
  }

  async function choose(ctx) {
    const userId = ctx.from?.id;
    if (!userId || !peekPending(userId)) {
      await safeAnswer(ctx, 'plan_object_no_context', true);
      return;
    }
    try {
      const user = await db.ensureUser(userId);
      const { objects } = await ensurePrimaryObject(user, peekPending(userId));
      const keyboard = buildChooseKeyboard(objects);
      if (!keyboard.length) {
        await ctx.reply(msg('plan_object_no_objects'));
        return;
      }
      await ctx.reply(msg('plan_object_choose_prompt'), {
        reply_markup: { inline_keyboard: keyboard },
      });
      await ctx.answerCbQuery();
    } catch (err) {
      console.error('plan_flow choose error', err);
      await safeAnswer(ctx, 'plan_object_error', true);
    }
  }

  async function pick(ctx, objectId) {
    await confirm(ctx, objectId);
  }

  async function create(ctx) {
    const userId = ctx.from?.id;
    if (!userId) {
      await safeAnswer(ctx, 'plan_object_no_context', true);
      return;
    }
    const diagnosis = consumePending(userId);
    if (!diagnosis) {
      await safeAnswer(ctx, 'plan_object_no_context', true);
      return;
    }
    try {
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
      const user = await db.ensureUser(userId);
      const object = await db.getObjectById(objectId);
      if (!object || object.user_id !== user.id) {
        await safeAnswer(ctx, 'plan_object_not_found', true);
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
      const plan = await db.createPlan({
        user_id: user.id,
        object_id: object.id,
        case_id: caseRow.id,
        title: buildPlanTitle(object, diagnosis),
      });
      const stageDefs = await collectStageDefinitions(catalog, diagnosis, object);
      if (!stageDefs.length) {
        await ctx.reply(msg('plan_object_error'));
        return;
      }
      await db.createStagesWithOptions(plan.id, stageDefs);
      await safeAnswer(ctx, 'plan_object_saved');
      await planWizard.showPlanTable(ctx.chat.id, plan.id);
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

function buildPlanTitle(object, data) {
  const crop = data?.crop_ru || data?.crop || object?.name || msg('object.default_name');
  const disease = data?.disease_name_ru || data?.disease || msg('diagnosis.fallback_disease');
  return `${crop} — ${disease}`;
}

async function collectStageDefinitions(catalog, data, object) {
  try {
    const stages = (await catalog.suggestStages({
      crop: data?.crop,
      disease: data?.disease,
    })) || [];
    const region = object?.location_tag || null;
    const defs = [];
    for (const stage of stages) {
      const options = await catalog.suggestOptions({
        crop: data?.crop,
        disease: data?.disease,
        region,
        stageKind: stage.kind,
        limit: stage.meta?.option_limit || 3,
      });
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

module.exports = { createPlanFlow };
