'use strict';

const { msg } = require('../utils');

function formatDose(option) {
  if (option.dose_value == null && !option.dose_unit) return '';
  const value = option.dose_value != null ? option.dose_value : '';
  return `${value}${option.dose_unit ? ` ${option.dose_unit}` : ''}`.trim();
}

function renderOptionLabel(option) {
  const dose = formatDose(option);
  if (dose) {
    return `${option.product} • ${dose}`;
  }
  return option.product;
}

function buildOptionButton(planId, stageId, option) {
  return {
    text: renderOptionLabel(option),
    callback_data: `pick_opt|${planId}|${stageId}|${option.id}`,
  };
}

function renderStageText(stage) {
  const parts = [`• ${stage.title}`];
  if (stage.note) parts.push(stage.note);
  if (stage.phi_days) {
    parts.push(msg('phi_hint', { days: stage.phi_days }));
  }
  return parts.filter(Boolean).join('\n');
}

function createPlanWizard({ bot, db }) {
  if (!bot) throw new Error('plan_wizard requires bot instance');
  if (!db) throw new Error('plan_wizard requires db service');

  async function showPlanTable(chatId, planId, opts = {}) {
    const stages = await db.getPlanStagesWithOptions(planId);
    if (!stages.length) return;
    for (const stage of stages) {
      const buttons = [];
      (stage.options || [])
        .slice(0, opts.limit || 3)
        .forEach((option) => buttons.push([buildOptionButton(planId, stage.id, option)]));
      if (stage.kind === 'trigger') {
        buttons.push([
          {
            text: msg('plan_trigger_button'),
            callback_data: `plan_trigger|${planId}|${stage.id}`,
          },
        ]);
      }
      const replyMarkup = buttons.length ? { inline_keyboard: buttons } : undefined;
      await bot.telegram.sendMessage(chatId, renderStageText(stage), {
        reply_markup: replyMarkup,
      });
    }
  }

  return { showPlanTable };
}

module.exports = { createPlanWizard };
