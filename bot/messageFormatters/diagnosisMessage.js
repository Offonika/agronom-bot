const { msg } = require('../utils');
const { list, dict, diseaseNameRu } = require('../i18n');

const LOW_CONFIDENCE_THRESHOLD = 0.6;

const FOLLOWUP_KEYWORDS = [
  { pattern: /(курс|повтор|через\s+сколько|следующ)/i, key: 'course' },
  { pattern: /(что\s+это|простыми\s+словами|от\s+чего|почему)/i, key: 'what_is' },
  { pattern: /(препарат|регион|купить|чем\s+обработ)/i, key: 'products' },
  { pattern: /(есть|урожай|безопас)/i, key: 'safety' },
];

const FAQ_INTENTS = [
  {
    id: 'what_is_disease',
    promptKey: 'faq.what_is_disease.prompt',
    patterns: [/что\s+это/i, /простыми\s+словами/i, /почему\s+так/i, /что\s+за\s+болезн/i],
  },
  {
    id: 'regional_products',
    promptKey: 'faq.regional_products.prompt',
    patterns: [/препарат/i, /регион/i, /чем\s+обработ/i],
  },
  {
    id: 'safety_eat',
    promptKey: 'faq.safety_eat.prompt',
    patterns: [/есть/i, /безопас/i, /можно\s+ли\s+есть/i],
  },
  {
    id: 'after_treatment',
    promptKey: 'faq.after_treatment.prompt',
    patterns: [/после\s+обработ/i, /пятн/i, /не\s+ушл/i],
  },
];

function cleanText(value) {
  return String(value || '').trim();
}

function dedupeParagraphs(text) {
  if (!text) return '';
  const seen = new Set();
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const result = [];
  for (const line of lines) {
    const key = line.toLowerCase().replace(/\s+/g, ' ');
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(line);
  }
  return result.join('\n');
}

function asPercent(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) return '0';
  return Math.round(Math.max(0, Math.min(1, value)) * 100).toString();
}

function normalizeReasoning(reasoning) {
  if (Array.isArray(reasoning)) {
    return reasoning.map((item) => cleanText(item)).filter(Boolean);
  }
  const text = cleanText(reasoning);
  if (!text) return [];
  const parts = text.split(/[•\n]/).map((part) => part.trim()).filter(Boolean);
  return parts.length ? parts : [text];
}

function mapDiseaseName(data) {
  if (data?.disease_name_ru) return data.disease_name_ru;
  const localized = diseaseNameRu(data?.disease);
  if (localized) return localized;
  return data?.disease || msg('diagnosis.fallback_disease');
}

function formatPlanSummary(plan) {
  if (!plan) return '';
  const parts = [];
  if (plan.product) {
    parts.push(`Препарат: ${plan.product}`);
  } else if (plan.substance) {
    parts.push(`Группа ДВ: ${plan.substance}`);
  }
  if (plan.method) {
    parts.push(`Способ: ${plan.method}`);
  }
  const dosage =
    plan.dosage_value != null && plan.dosage_unit
      ? `${plan.dosage_value} ${plan.dosage_unit}`.trim()
      : plan.dosage || '';
  if (dosage) {
    parts.push(`Доза: ${dosage}`);
  }
  if (Number.isFinite(plan.phi_days)) {
    parts.push(`PHI: ${plan.phi_days} дн.`);
  } else if (plan.phi) {
    parts.push(`PHI: ${plan.phi}`);
  }
  if (plan.safety_note) {
    parts.push(`⚠️ ${plan.safety_note}`);
  }
  if (!plan.product && !plan.substance) {
    parts.push('Подберу разрешённый препарат под ваш регион.');
  } else if (!dosage) {
    parts.push('ℹ️ Дозировку уточните на упаковке выбранного средства.');
  }
  return parts.filter(Boolean).join('\n');
}

function buildFallbackAssistant(data) {
  const crop = mapCropName(data);
  const disease = mapDiseaseName(data);
  const confidence = asPercent(data.confidence);
  const reasoning = normalizeReasoning(data.reasoning);
  const sections = [];
  sections.push(`📸 Диагноз\nКультура: ${crop}. Диагноз: ${disease}. Уверенность: ${confidence}%.`);
  if (reasoning.length) {
    sections.push(`🧪 Почему так\n${reasoning.map((line) => `• ${line}`).join('\n')}`);
  }
  const plan = formatPlanSummary(data.treatment_plan);
  if (plan) {
    sections.push(`🧴 Что делать\n${plan}`);
  } else {
    sections.push('🧴 Что делать\nУдалите поражённые листья, обеспечьте проветривание и примените разрешённый фунгицид, соблюдая инструкцию.');
  }
  sections.push(
    `⏰ Что дальше\n• ${msg('next.actions.green_window')}\n• ${msg('next.actions.phi')}\n• ${msg('next.actions.assist')}`,
  );
  return sections.join('\n\n');
}

function buildAssistantText(data) {
  const parts = [];
  const assistantText = dedupeParagraphs(cleanText(data.assistant_ru));
  if (assistantText) {
    parts.push(assistantText);
  } else {
    parts.push(buildFallbackAssistant(data));
  }
  if (data.plan_missing_reason) {
    parts.push(`ℹ️ ${data.plan_missing_reason}`);
  }
  if (data.need_clarify_crop) {
    parts.push(msg('clarify.crop.title'));
  }
  if (data.need_reshoot) {
    const tips = (Array.isArray(data.reshoot_tips) ? data.reshoot_tips : list('reshoot.tips'))
      .map((tip) => `• ${tip}`)
      .join('\n');
    parts.push(`${msg('reshoot.title')}\n${msg('reshoot.action')}\n${tips}`);
  }
  return parts.filter(Boolean).join('\n\n');
}

function buildKeyboardLayout(data) {
  const inline = [];
  if (data.need_clarify_crop && Array.isArray(data.clarify_crop_variants) && data.clarify_crop_variants.length) {
    const clarifyRow = data.clarify_crop_variants.slice(0, 4).map((variant) => ({
      text: variant,
      callback_data: `clarify_crop|${encodeURIComponent(variant).slice(0, 60)}`,
    }));
    inline.push(clarifyRow);
  }
  inline.push([{ text: msg('cta.schedule'), callback_data: 'plan_treatment' }]);
  inline.push([{ text: msg('cta.remind_phi'), callback_data: 'phi_reminder' }]);
  inline.push([{ text: msg('cta.pdf'), callback_data: 'pdf_note' }]);
  inline.push([{ text: msg('cta.ask_products'), callback_data: 'ask_products' }]);
  if (data.need_reshoot) {
    inline.push([{ text: msg('cta.reshoot'), callback_data: 'reshoot_photo' }]);
  }
  return { inline_keyboard: inline };
}

function detectFaqIntent(text) {
  if (!text) return null;
  const normalized = text.trim();
  if (!normalized) return null;
  for (const intent of FAQ_INTENTS) {
    if (intent.patterns.some((pattern) => pattern.test(normalized))) {
      return intent.id;
    }
  }
  return null;
}

function formatFaqAnswer(intentId, data) {
  const crop = mapCropName(data || {});
  const disease = mapDiseaseName(data || {});
  const reasoning = normalizeReasoning(data?.reasoning);
  const planSummary = formatPlanSummary(data?.treatment_plan);
  switch (intentId) {
    case 'what_is_disease': {
      const res = [`${msg('faq.what_is_disease.prompt')} — это ${disease.toLowerCase()} на ${crop}.`];
      if (reasoning.length) {
        res.push(`${msg('faq.card.why')}\n${reasoning.map((line) => `• ${line}`).join('\n')}`);
      }
      res.push(msg('faq.what_is_disease.aftercare'));
      return res.join('\n\n');
    }
    case 'regional_products': {
      return [msg('faq.regional_products.answer'), planSummary || '', msg('faq.card.tail')]
        .filter(Boolean)
        .join('\n\n');
    }
    case 'safety_eat': {
      const phi = data?.treatment_plan?.phi_days ?? data?.treatment_plan?.phi ?? '…';
      return msg('faq.safety_eat.answer', { phi_days: phi });
    }
    case 'after_treatment':
      return msg('faq.after_treatment.answer');
    default:
      return '';
  }
}

function extractKeyword(text) {
  if (!text) return null;
  for (const entry of FOLLOWUP_KEYWORDS) {
    if (entry.pattern.test(text)) return entry.key;
  }
  return null;
}

function defaultFollowupAnswer(keyword) {
  switch (keyword) {
    case 'course':
      return 'Дай препарату 24–48 ч., оцени динамику и при необходимости повтори обработку другим действующим веществом — помогу подобрать схему.';
    case 'what_is':
      return 'Это грибковая проблема: ей помогают проветривание, санитарная обрезка и своевременные фунгицидные обработки.';
    case 'products':
      return 'Подскажу бренды и ДВ, разрешённые в вашем регионе, когда назовёте область/край.';
    case 'safety':
      return 'Смотри срок ожидания (PHI) на упаковке препарата. После обработки дождись истечения PHI и тщательно вымой урожай.';
    default:
      if (!keyword) {
        return msg('followup_default');
      }
      return null;
  }
}

function pickAssistantFollowup(diag, keyword) {
  if (!diag?.assistant_followups_ru || !diag.assistant_followups_ru.length) return null;
  const lowerKey = keyword ? keyword.toLowerCase() : '';
  if (lowerKey) {
    const matched = diag.assistant_followups_ru.find((line) =>
      line.toLowerCase().includes(lowerKey.slice(0, 4)),
    );
    if (matched) return matched;
  }
  return diag.assistant_followups_ru[0];
}

function resolveFollowupReply(diag, userText) {
  const keyword = extractKeyword(userText || '');
  const assistantReply = pickAssistantFollowup(diag, keyword);
  if (assistantReply) return assistantReply;
  return defaultFollowupAnswer(keyword);
}

function mapCropName(data) {
  const cropRu = cleanText(data?.crop_ru);
  if (cropRu) return cropRu;
  const raw = cleanText(data?.crop);
  if (!raw) return msg('diagnosis.fallback_crop');
  const map = dict('diagnosis.crop_map');
  const translated = map[raw.toLowerCase()];
  return translated || raw;
}

module.exports = {
  LOW_CONFIDENCE_THRESHOLD,
  buildAssistantText,
  buildKeyboardLayout,
  detectFaqIntent,
  formatFaqAnswer,
  resolveFollowupReply,
  FAQ_INTENTS,
};
