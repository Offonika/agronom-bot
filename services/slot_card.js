'use strict';

const DEFAULT_TZ = process.env.AUTOPLAN_TIMEZONE || 'Europe/Moscow';

function formatSlotCard({ slot, stageName, objectName, translate }) {
  if (!slot) return '';
  const t = translate || ((key, vars) => defaultTranslate(key, vars));
  const safeStage = stageName || t('plan_slot_stage_fallback');
  const safeObject = objectName || t('plan_slot_object_fallback');
  const header = t('plan_slot_card_title', { stage: safeStage, object: safeObject });
  const windowLine = t('plan_slot_card_window', {
    date: formatDate(slot.start),
    start: formatTime(slot.start),
    end: formatTime(slot.end),
  });
  const reasonBlock = formatReasonBlock(slot.reason, t);
  const footer = t('plan_slot_card_footer', { object: safeObject });
  return [header, windowLine, reasonBlock, footer].filter(Boolean).join('\n\n');
}

function buildSlotKeyboard(slotId, translate) {
  const t = translate || ((key) => defaultTranslate(key));
  return {
    inline_keyboard: [
      [
        {
          text: t('plan_slot_accept_button'),
          callback_data: `plan_slot_accept|${slotId}`,
        },
      ],
      [
        {
          text: t('plan_slot_reschedule_button'),
          callback_data: `plan_slot_reschedule|${slotId}`,
        },
        {
          text: t('plan_slot_cancel_button'),
          callback_data: `plan_slot_cancel|${slotId}`,
        },
      ],
    ],
  };
}

function formatReasonBlock(reasons, translate) {
  const t = translate || ((key) => defaultTranslate(key));
  const list = (reasons || []).map((item) => `• ${item}`).join('\n');
  if (!list) {
    return t('plan_slot_reason_fallback') || '';
  }
  return t('plan_slot_card_reason', { reason: list });
}

function formatDate(date) {
  return new Intl.DateTimeFormat('ru-RU', {
    day: '2-digit',
    month: 'long',
    timeZone: DEFAULT_TZ,
  }).format(date);
}

function formatTime(date) {
  return new Intl.DateTimeFormat('ru-RU', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: DEFAULT_TZ,
  }).format(date);
}

function defaultTranslate(key, vars = {}) {
  let template = key;
  switch (key) {
    case 'plan_slot_stage_fallback':
      template = 'этап';
      break;
    case 'plan_slot_object_fallback':
      template = 'растение';
      break;
    case 'plan_slot_card_title':
      template = 'Шаг 3/3. Предлагаю обработку для {object} — {stage}.';
      break;
    case 'plan_slot_card_window':
      template = '🗓 {date}, {start}–{end}';
      break;
    case 'plan_slot_card_reason':
      template = 'Почему это окно:\n{reason}';
      break;
    case 'plan_slot_card_footer':
      template = 'План для {object}.';
      break;
    case 'plan_slot_reason_fallback':
      template = '';
      break;
    case 'plan_slot_accept_button':
      template = 'Принять';
      break;
    case 'plan_slot_reschedule_button':
      template = 'Выбрать другое время';
      break;
    case 'plan_slot_cancel_button':
      template = 'Отменить';
      break;
    default:
      template = key;
  }
  return template.replace(/\{([^}]+)\}/g, (_, k) => {
    if (Object.prototype.hasOwnProperty.call(vars, k)) {
      const value = vars[k];
      return value == null ? '' : String(value);
    }
    return _;
  });
}

module.exports = {
  formatSlotCard,
  buildSlotKeyboard,
};

