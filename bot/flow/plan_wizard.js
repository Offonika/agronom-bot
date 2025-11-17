'use strict';

const { msg } = require('../utils');
const planApi = require('../planApi');

function formatDose(option) {
  if (option.dose_value == null && !option.dose_unit) return '';
  const value = option.dose_value != null ? option.dose_value : '';
  return `${value}${option.dose_unit ? ` ${option.dose_unit}` : ''}`.trim();
}

function renderOptionLabel(option) {
  const title = option.product || option.product_name || option.product_code || msg('plan_option_fallback');
  const dose = formatDose(option);
  if (dose) {
    return `${title} • ${dose}`;
  }
  return title;
}

function buildOptionButton(planId, stageId, option) {
  return {
    text: renderOptionLabel(option),
    callback_data: `pick_opt|${planId}|${stageId}|${option.id}`,
  };
}

function renderStageText(stage) {
  const title = stage.title || stage.name || msg('plan_stage_default');
  const parts = [`• ${title}`];
  if (stage.note) parts.push(stage.note);
  if (stage.phi_days) {
    parts.push(msg('phi_hint', { days: stage.phi_days }));
  }
  if ((stage.kind || '').toLowerCase() === 'trigger') {
    parts.push(msg('plan_trigger_hint'));
  }
  if (stage.diff_summary) {
    parts.push(stage.diff_summary);
  }
  return parts.filter(Boolean).join('\n');
}

function createPlanWizard({ bot, db }) {
  if (!bot) throw new Error('plan_wizard requires bot instance');
  if (!db) throw new Error('plan_wizard requires db service');

  async function showPlanTable(chatId, planId, opts = {}) {
    const { userId, diffAgainst = null } = opts;
    const abortController = typeof AbortController === 'function' ? new AbortController() : null;
    const signal = opts.signal || abortController?.signal;
    const plan = await fetchPlanPayload(planId, userId, diffAgainst, db, signal);
    if (!plan?.stages?.length) return;
    for (const stage of plan.stages) {
      const text = renderStageText(stage);
      const buttons = [];
      (stage.options || [])
        .slice(0, opts.limit || 3)
        .forEach((option) => buttons.push([buildOptionButton(plan.plan_id, stage.id, option)]));
      if (stage.kind === 'trigger') {
        buttons.push([
          {
            text: msg('plan_trigger_button'),
            callback_data: `plan_trigger|${plan.plan_id}|${stage.id}`,
          },
        ]);
      }
      const replyMarkup = buttons.length ? { inline_keyboard: buttons } : undefined;
      await bot.telegram.sendMessage(chatId, text, {
        reply_markup: replyMarkup,
      });
    }
  }

  return { showPlanTable };
}

async function fetchPlanPayload(planId, userId, diffAgainst, db, signal) {
  if (userId) {
    try {
      const apiPlan = await planApi.fetchPlan({
        planId,
        userId,
        includePayload: false,
        diffAgainst,
        signal,
      });
      if (apiPlan && apiPlan.stages) {
        return normalizeApiPlan(apiPlan);
      }
    } catch (err) {
      console.error('plan_wizard api fetch failed', err);
    }
  }
  try {
    const stages = await db.getPlanStagesWithOptions(planId);
    return normalizeDbPlan(planId, stages);
  } catch (err) {
    console.error('plan_wizard db fetch failed', err);
    return null;
  }
}

function normalizeApiPlan(apiPlan) {
  return {
    plan_id: apiPlan.plan_id || apiPlan.id,
    status: apiPlan.status,
    version: apiPlan.version,
    diff: apiPlan.diff || null,
    stages: (apiPlan.stages || []).map(normalizeApiStage),
  };
}

function normalizeApiStage(stage) {
  const options = Array.isArray(stage.options) ? stage.options.map(normalizeApiOption) : [];
  const meta = stage.meta || {};
  const trigger = stage.trigger || meta.trigger || null;
  return {
    id: stage.id,
    plan_id: stage.plan_id || null,
    title: stage.name || stage.title || msg('plan_stage_default'),
    kind: stage.kind || meta.kind || 'season',
    note: stage.notes || stage.note || trigger,
    phi_days: stage.phi_days ?? null,
    meta: { ...meta, trigger },
    diff_summary: extractStageDiff(stage.diff),
    options,
  };
}

function extractStageDiff(diff) {
  if (!diff || typeof diff !== 'object') return null;
  const changes = [];
  if (diff.added) {
    changes.push(msg('plan_diff_added', { entity: diff.added }));
  }
  if (diff.removed) {
    changes.push(msg('plan_diff_removed', { entity: diff.removed }));
  }
  if (Array.isArray(diff.changed)) {
    diff.changed.forEach((item) => {
      const field = item.field || 'field';
      changes.push(msg('plan_diff_changed', { field, from: item.from ?? '-', to: item.to ?? '-' }));
    });
  }
  return changes.length ? `${msg('plan_diff_header')}\n${changes.join('\n')}` : null;
}

function normalizeApiOption(option) {
  return {
    id: option.id,
    product: option.product_name || option.product_code || option.product,
    product_name: option.product_name || null,
    product_code: option.product_code || null,
    ai: option.ai || null,
    dose_value: option.dose_value ?? null,
    dose_unit: option.dose_unit || null,
    method: option.method || null,
    needs_review: Boolean(option.needs_review),
    notes: option.notes || null,
    phi_days: option.phi_days ?? null,
    is_selected: Boolean(option.is_selected),
    meta: {
      ...(option.meta || {}),
      product_code: option.product_code || option.meta?.product_code || null,
      notes: option.notes || option.meta?.notes || null,
      needs_review: Boolean(option.needs_review ?? option.meta?.needs_review),
      phi_days: option.phi_days ?? option.meta?.phi_days ?? null,
    },
  };
}

function normalizeDbPlan(planId, stages) {
  return {
    plan_id: planId,
    status: null,
    version: null,
    diff: null,
    stages: stages.map((stage) => ({
      id: stage.id,
      plan_id: stage.plan_id,
      title: stage.title,
      kind: stage.kind,
      note: stage.note,
      phi_days: stage.phi_days,
      meta: stage.meta,
      options: stage.options || [],
    })),
  };
}

module.exports = { createPlanWizard };
