const { msg } = require('../utils');
const { list, dict, diseaseNameRu } = require('../i18n');

const rawLowConfidence = Number(process.env.LOW_CONFIDENCE_THRESHOLD);
const LOW_CONFIDENCE_THRESHOLD = Number.isFinite(rawLowConfidence) ? rawLowConfidence : 0.6;
const rawLowConfidenceRecheck = Number(process.env.LOW_CONFIDENCE_RECHECK_THRESHOLD || '0.65');
const LOW_CONFIDENCE_RECHECK_THRESHOLD = Number.isFinite(rawLowConfidenceRecheck)
  ? Math.max(LOW_CONFIDENCE_THRESHOLD, Math.min(rawLowConfidenceRecheck, 1))
  : Math.max(LOW_CONFIDENCE_THRESHOLD, 0.65);
const WATER_STRESS_RE =
  /(ж[её]стк\w+\s+вод|хлорирован|фторирован|засол|застой\s+влаг|пересуш|перелив|залив|переувлаж)/i;
const SOIL_FLUSH_RE = /(промо(й|йте)\s+грунт|промыв(к|а)\s+грунт)/i;
const ROOT_ROT_RISK_RE = /(застой\s+влаг|перелив|залив|переувлаж|подгнив|гнил[ьи]\s*корн|гниль\s*корн|root\s*rot)/i;
const LEAF_SPOT_RE = /(пятн|leaf\s*spot|\bspot\b)/i;
const WATER_STATUS_WET_RE = /(мокр|сыро|болот|стоит\s+вод|в\s+поддон(е)?\s+вод|не\s+просых|перелив|залив)/i;
const WATER_STATUS_DRY_RE = /(сухо|сухой|пересох|пересуш)/i;
const WATER_STATUS_MOIST_RE = /(слегка\s*влаж|умеренно\s*влаж|влажно)/i;
const SIMPLE_NO_RE = /^(нет|неа|не)$/i;
const SIMPLE_YES_RE = /^(да|ага|есть)$/i;
const SOIL_TYPE_RE =
  /(торф|верхов|нейтральн\w*\s+торф|кисл\w*\s+торф|цеолит|диатомит|лава|пеностек|кварц|мрамор|перлит|вермикулит|минеральн|камен|глин|плотн\w*\s+грунт|рыхл|кора|кокос|субстрат|почвосмес|черноз[её]м|перегно|компост|гумус|биогумус|навоз|земл|почв|суглин|пес[кч]|листов\w*\s+перегно|садов\w*\s+земл|обычн\w*\s+земл)/i;
const WATER_SOIL_CONTEXT_RE = /(грунт|полив|влажн|корн|дренаж|поддон|застой\s+влаг|перелив|залив|пересуш|ж[её]стк\w+\s+вод|засол)/i;
const FOLLOWUP_SECTION_HEADER_RE = /^(можно\s+спросить|что\s+уточнить|уточняющие\s+вопросы)\s*:?\s*$/i;
const BULLET_LINE_RE = /^([•\-*]|\d+[.)])\s+/;
const QUESTION_LINE_RE = /\?\s*$/;
const CHANNEL_LINE_RE = /(@agronom_ai|https?:\/\/t\.me\/agronom_ai)/i;
const WATER_CHECKLIST_HEADER_RE = /что\s+уточнить\s+перед\s+выводами\s+по\s+вод[еы]\/грунт/i;
const ROOT_ROT_CHECKLIST_HEADER_RE = /как\s+проверить\s+перелив|подгниван/i;
const LEAF_SPOT_CHECKLIST_HEADER_RE = /базов\w+\s+разбор\s+пятен/i;
const NO_SMELL_RE = /(нет\s+запах[ау]?|запах[ау]?\s+нет|без\s+запах|не\s+пахнет)/i;
const HAS_SMELL_RE =
  /(кисл\w*\s+запах|болотн\w*\s+запах|затхл\w*\s+запах|гнилост\w*\s+запах|запах\s+есть|есть\s+запах|пахнет|воняет?)/i;
const CHEMICAL_ACTION_RE =
  /(фунгицид|медн\w+\s+препарат|медн\w+\s+фунгицид|фосетил|bacillus\s*subtilis|биофунгицид|системн\w+\s+фунгицид|пролив\s+.*препарат)/i;
const ROOT_ROT_PRIMARY_RE =
  /(наибол[её]е\s+вероятн[а-яёa-z-]*\s+проблем[а-яёa-z-]*.*(гнил|подгнив)|подозрен[а-яёa-z-]*\s+на\s+корнев[а-яёa-z-]*.*гнил|корнев[а-яёa-z-]*\/прикорнев[а-яёa-z-]*\s+гнил)/i;
const ROOT_ROT_EVIDENCE_RE =
  /(корн[ьи].*(мягк|темн|слизист|каш)|мягк[а-яёa-z-]*\s+основан|кисл[а-яёa-z-]*\s+запах|болотн[а-яёa-z-]*\s+запах|гнил[ьи]\s*корн|подгнив)/i;
const OVERCONFIDENT_VISIBILITY_RE =
  /(листь(?:ев|я)?\s+не\s+видно|на\s+фото\s+нет\s+лист|виден\s+только\s+ствол\s+и\s+грунт)/i;
const RISKY_LOW_CONF_ACTION_RE =
  /(аккуратно\s+вын[ьъ]т[еия]|достан[ьъ]т[еия]\s+растение|вын[ьъ]т[еия]\s+растение|среж(?:ь|ьте|те)|обреж(?:ь|ьте|те)|пересад(?:и|ите|ка)|промо(?:й|йте)\s+грунт|пролей(?:те)?\s+.*фунгицид|обработ(?:ай|айте|ать)\s+.*(инсектицид|фунгицид))/i;
const ROOT_ROT_NEGATION_RE =
  /(гнил[ьи]\s+нет|нет\s+гнил[ьи]|корни\s+(плотн|светл|упруг|здоров)|запах[ау]?\s+нет|без\s+запах|не\s+пахнет|заразы\s+и\s+гнили\s+нет)/i;
const ROOT_ROT_EXPLICIT_NEGATION_RE =
  /(гнил[ьи]\s+нет|нет\s+гнил[ьи]|корни\s+(плотн|светл|упруг|здоров)|заразы\s+и\s+гнили\s+нет)/i;
const ROOT_ROT_STRONG_SIGNAL_RE =
  /(мягк|слизист|каш|кисл\w*\s+запах|болотн\w*\s+запах|гнил[ьи]|подгнив)/i;
const rawAssistantMaxChars = Number(process.env.DIAG_ASSISTANT_MAX_CHARS || '1800');
const DIAG_ASSISTANT_MAX_CHARS = Number.isFinite(rawAssistantMaxChars)
  ? Math.max(1000, Math.round(rawAssistantMaxChars))
  : 1800;
const rawAssistantMaxLines = Number(process.env.DIAG_ASSISTANT_MAX_LINES || '22');
const DIAG_ASSISTANT_MAX_LINES = Number.isFinite(rawAssistantMaxLines)
  ? Math.max(12, Math.round(rawAssistantMaxLines))
  : 22;
const rawAssistantDetailsMaxChars = Number(process.env.DIAG_ASSISTANT_DETAILS_MAX_CHARS || '3200');
const DIAG_ASSISTANT_DETAILS_MAX_CHARS = Number.isFinite(rawAssistantDetailsMaxChars)
  ? Math.max(1200, Math.round(rawAssistantDetailsMaxChars))
  : 3200;
const rawAssistantDetailsMaxLines = Number(process.env.DIAG_ASSISTANT_DETAILS_MAX_LINES || '48');
const DIAG_ASSISTANT_DETAILS_MAX_LINES = Number.isFinite(rawAssistantDetailsMaxLines)
  ? Math.max(18, Math.round(rawAssistantDetailsMaxLines))
  : 48;
const rawAssistantShortMaxChars = Number(process.env.DIAG_ASSISTANT_SHORT_MAX_CHARS || '900');
const DIAG_ASSISTANT_SHORT_MAX_CHARS = Number.isFinite(rawAssistantShortMaxChars)
  ? Math.max(400, Math.round(rawAssistantShortMaxChars))
  : 900;
const rawAssistantShortMaxLines = Number(process.env.DIAG_ASSISTANT_SHORT_MAX_LINES || '12');
const DIAG_ASSISTANT_SHORT_MAX_LINES = Number.isFinite(rawAssistantShortMaxLines)
  ? Math.max(6, Math.round(rawAssistantShortMaxLines))
  : 12;
const MAX_BULLETS_IN_ROW = 5;

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

function normalizeShortReply(value) {
  return cleanText(value)
    .toLowerCase()
    .replace(/^[\s.,!?;:()\-]+|[\s.,!?;:()\-]+$/g, '');
}

function normalizeUserFacingLanguage(value) {
  let text = cleanText(value);
  if (!text) return text;
  text = text
    .replace(/(?<!\p{L})листов(?:ых)?\s+влагалищ(?:ах|а|е|у|ами)?(?!\p{L})/giu, 'пазухах листьев')
    .replace(/(?<!\p{L})листовые\s+влагалища(?!\p{L})/giu, 'пазухи листьев')
    .replace(/(?<!\p{L})посмотрите\s+пазухи(?!\p{L})/giu, 'проверьте пазухи')
    .replace(/(?<!\p{L})тебе(?!\p{L})/giu, 'вам')
    .replace(/(?<!\p{L})тебя(?!\p{L})/giu, 'вас')
    .replace(/(?<!\p{L})тобой(?!\p{L})/giu, 'вами')
    .replace(/(?<!\p{L})твой(?!\p{L})/giu, 'ваш')
    .replace(/(?<!\p{L})твоя(?!\p{L})/giu, 'ваша')
    .replace(/(?<!\p{L})твои(?!\p{L})/giu, 'ваши')
    .replace(/(?<!\p{L})ты(?!\p{L})/giu, 'вы')
    .replace(/(?<!\p{L})дай(?!\p{L})/giu, 'дайте')
    .replace(/(?<!\p{L})поставь(?!\p{L})/giu, 'поставьте')
    .replace(/(?<!\p{L})проверь(?!\p{L})/giu, 'проверьте')
    .replace(/(?<!\p{L})напиши(?!\p{L})/giu, 'напишите')
    .replace(/(?<!\p{L})нажми(?!\p{L})/giu, 'нажмите')
    .replace(/(?<!\p{L})жми(?!\p{L})/giu, 'нажмите')
    .replace(/(?<!\p{L})отправь(?!\p{L})/giu, 'отправьте')
    .replace(/(?<!\p{L})пришли(?!\p{L})/giu, 'пришлите')
    .replace(/(?<!\p{L})дошли(?!\p{L})/giu, 'дошлите')
    .replace(/(?<!\p{L})попробуй(?!\p{L})/giu, 'попробуйте')
    .replace(/(?<!\p{L})убери(?!\p{L})/giu, 'уберите')
    .replace(/(?<!\p{L})изолируй(?!\p{L})/giu, 'изолируйте');
  return text;
}

function normalizeLineKey(line) {
  return cleanText(line)
    .toLowerCase()
    .replace(/#\s*\d{1,5}/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function isBulletLine(line) {
  return BULLET_LINE_RE.test(line);
}

function isQuestionLine(line) {
  if (!line) return false;
  const body = cleanText(line).replace(BULLET_LINE_RE, '');
  return QUESTION_LINE_RE.test(body);
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
    const key = normalizeLineKey(line);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(line);
  }
  return result.join('\n');
}

function compactAssistantText(text, options = {}) {
  const maxLines = Number.isFinite(Number(options.maxLines))
    ? Number(options.maxLines)
    : DIAG_ASSISTANT_MAX_LINES;
  const maxChars = Number.isFinite(Number(options.maxChars))
    ? Number(options.maxChars)
    : DIAG_ASSISTANT_MAX_CHARS;
  if (!text) return '';
  const lines = text
    .split('\n')
    .map((line) => cleanText(line))
    .filter(Boolean);
  if (!lines.length) return '';

  const compact = [];
  let consecutiveBullets = 0;
  for (const line of lines) {
    const bullet = isBulletLine(line);
    if (bullet) {
      consecutiveBullets += 1;
      if (consecutiveBullets > MAX_BULLETS_IN_ROW) {
        continue;
      }
    } else {
      consecutiveBullets = 0;
    }
    compact.push(line);
    if (compact.length >= maxLines) {
      break;
    }
  }

  let out = compact.join('\n');
  if (out.length > maxChars) {
    const truncatedText = out.slice(0, maxChars).trimEnd();
    const boundaryRe = /([.!?](?:\s|$)|\n)/g;
    let match;
    let lastBoundary = -1;
    while ((match = boundaryRe.exec(truncatedText)) !== null) {
      lastBoundary = boundaryRe.lastIndex;
    }
    if (lastBoundary >= Math.floor(maxChars * 0.55)) {
      out = truncatedText.slice(0, lastBoundary).trimEnd();
    } else {
      const lastNewline = truncatedText.lastIndexOf('\n');
      if (lastNewline >= Math.floor(maxChars * 0.55)) {
        out = truncatedText.slice(0, lastNewline).trimEnd();
      } else {
        const lastSpace = truncatedText.lastIndexOf(' ');
        out = (lastSpace > 0 ? truncatedText.slice(0, lastSpace) : truncatedText).trimEnd();
      }
    }
  }
  out = out.replace(/[,:;•\-–—]\s*$/u, '').trimEnd();
  return out;
}

function preprocessAssistantLines(rawText) {
  const lines = String(rawText || '').split('\n');
  if (!lines.length) return [];
  const out = [];
  let skipFollowupQuestions = false;
  for (const rawLine of lines) {
    const line = normalizeUserFacingLanguage(cleanText(rawLine).replace(/#\s*\d{1,5}/g, '').trim());
    if (!line) {
      skipFollowupQuestions = false;
      continue;
    }
    if (CHANNEL_LINE_RE.test(line)) {
      continue;
    }
    if (FOLLOWUP_SECTION_HEADER_RE.test(line)) {
      skipFollowupQuestions = true;
      continue;
    }
    if (skipFollowupQuestions) {
      if (isQuestionLine(line)) {
        continue;
      }
      skipFollowupQuestions = false;
    }
    out.push(line);
  }
  return out;
}

function hasStrongRootRotEvidence(data, baseText = '') {
  const source = [
    baseText,
    cleanText(data?.assistant_ru),
    normalizeReasoning(data?.reasoning).join('\n'),
    cleanText(data?.disease_name_ru),
    cleanText(data?.disease),
  ]
    .filter(Boolean)
    .join('\n');
  return ROOT_ROT_EVIDENCE_RE.test(source);
}

function sanitizeAssistantText(data, rawText) {
  const confidence =
    typeof data?.confidence === 'number' && !Number.isNaN(data.confidence)
      ? data.confidence
      : 0;
  const lowConfidenceMode = Boolean(data?.need_reshoot) || confidence < LOW_CONFIDENCE_THRESHOLD;
  const softVisibilityMode = Boolean(data?.need_reshoot) || confidence < 0.75;
  const lines = preprocessAssistantLines(rawText);
  if (!lines.length) return '';
  const rootRotRuledOutByUser = Boolean(data?._root_rot_ruled_out);
  const strongRootRotEvidence = !rootRotRuledOutByUser && hasStrongRootRotEvidence(data, lines.join('\n'));
  const antiRotEscalationMode = !strongRootRotEvidence;

  let removedRisky = false;
  let softenedVisibility = false;
  let softenedRootHypothesis = false;
  let removedChemistry = false;
  const out = [];
  for (const line of lines) {
    if (softVisibilityMode && OVERCONFIDENT_VISIBILITY_RE.test(line)) {
      softenedVisibility = true;
      out.push(
        msg('diagnosis.visibility_uncertain_line') ||
          'По текущим кадрам часть признаков по листьям читается ограниченно — лучше доснять лист крупно с обеих сторон.',
      );
      continue;
    }
    if (antiRotEscalationMode && ROOT_ROT_PRIMARY_RE.test(line)) {
      softenedRootHypothesis = true;
      out.push(
        msg('diagnosis.root_rot_unconfirmed_line') ||
          'По текущим фото гниль корней не подтверждена: сначала корректируем режим света/полива и наблюдаем динамику.',
      );
      continue;
    }
    if (antiRotEscalationMode && CHEMICAL_ACTION_RE.test(line)) {
      removedChemistry = true;
      continue;
    }
    if (lowConfidenceMode && RISKY_LOW_CONF_ACTION_RE.test(line)) {
      removedRisky = true;
      continue;
    }
    out.push(line);
  }
  if (antiRotEscalationMode && removedChemistry) {
    out.push(
      msg('diagnosis.care_priority_line') ||
        'Приоритет сейчас: свет + режим полива + контроль дренажа.',
    );
    out.push(
      msg('diagnosis.chemistry_hold_line') ||
        'Химические обработки пока не назначаю: сначала стабилизируем уход и уточняем признаки.',
    );
  }

  let normalized = dedupeParagraphs(out.join('\n'));
  if (!normalized) {
    normalized = dedupeParagraphs(cleanText(rawText));
  }
  if (lowConfidenceMode && (removedRisky || softenedVisibility || softenedRootHypothesis)) {
    normalized = [
      normalized,
      msg('diagnosis.low_confidence_safe_mode') ||
        '⚠️ При низкой уверенности используйте только щадящие шаги ухода. Для точного плана пришлите досъёмку.',
    ]
      .filter(Boolean)
      .join('\n\n');
  }
  return compactAssistantText(normalized, {
    maxChars: DIAG_ASSISTANT_DETAILS_MAX_CHARS,
    maxLines: DIAG_ASSISTANT_DETAILS_MAX_LINES,
  });
}

function asPercent(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) return '0';
  return Math.round(Math.max(0, Math.min(1, value)) * 100).toString();
}

function buildConfidenceLine(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) return '';
  return msg('diagnosis.confidence_line', { value: asPercent(value) });
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
    `⏰ Что дальше\n• ${msg('next.actions.green_window')}\n• ${msg('next.actions.assist')}`,
  );
  return sections.join('\n\n');
}

function dedupeSections(parts) {
  const seen = new Set();
  const out = [];
  for (const part of parts) {
    const value = cleanText(part);
    if (!value) continue;
    const key = normalizeLineKey(value);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

function stripBulletPrefix(line) {
  return cleanText(line).replace(BULLET_LINE_RE, '').trim();
}

function isSectionLikeLine(line) {
  return /[:：]\s*$/.test(line) && !QUESTION_LINE_RE.test(line);
}

function uniqueLines(lines = []) {
  const seen = new Set();
  const out = [];
  for (const line of lines) {
    const clean = cleanText(line);
    if (!clean) continue;
    const key = normalizeLineKey(clean);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(clean);
  }
  return out;
}

function buildShortSummary(data, assistantText = '') {
  const lines = assistantText
    .split('\n')
    .map((line) => cleanText(line))
    .filter(Boolean);
  const candidates = lines.filter((line) => !isBulletLine(line) && !isSectionLikeLine(line));
  const summary = uniqueLines(candidates).slice(0, 2).join(' ');
  if (summary) return summary;
  return (
    msg('diagnosis.short_summary', {
      crop: mapCropName(data),
      disease: mapDiseaseName(data),
    }) ||
    `По фото это похоже на «${mapDiseaseName(data)}» у культуры «${mapCropName(data)}».`
  );
}

function buildShortActions(data, assistantText = '') {
  const rawActions = assistantText
    .split('\n')
    .map((line) => cleanText(line))
    .filter((line) => isBulletLine(line))
    .map((line) => stripBulletPrefix(line))
    .filter(Boolean)
    .filter((line) => !isSectionLikeLine(line))
    .filter((line) => !QUESTION_LINE_RE.test(line))
    .filter((line) => !CHANNEL_LINE_RE.test(line));
  const actions = uniqueLines(rawActions).filter((line) => !CHEMICAL_ACTION_RE.test(line)).slice(0, 3);
  if (actions.length) return actions;
  const fallback = [];
  if (data?.treatment_plan?.method) {
    fallback.push(data.treatment_plan.method);
  }
  if (data?.treatment_plan?.safety_note) {
    fallback.push(data.treatment_plan.safety_note);
  }
  fallback.push(msg('next.actions.green_window') || 'Подберите окно с мягкими условиями и наблюдайте динамику.');
  return uniqueLines(fallback).slice(0, 3);
}

function buildShortQuestion(data, assistantText = '') {
  const lines = assistantText
    .split('\n')
    .map((line) => cleanText(line))
    .filter(Boolean);
  const inTextQuestion = lines.find((line) => QUESTION_LINE_RE.test(line));
  if (inTextQuestion) return inTextQuestion;
  const followupQuestion = Array.isArray(data?.assistant_followups_ru)
    ? data.assistant_followups_ru.map((line) => cleanText(line)).find((line) => QUESTION_LINE_RE.test(line))
    : '';
  if (followupQuestion) return followupQuestion;
  return msg('diagnosis.short_default_question') || 'Уточните, пожалуйста, как быстро сейчас просыхает грунт?';
}

function buildAssistantDetailsText(data) {
  const parts = [];
  const assistantText = sanitizeAssistantText(data, dedupeParagraphs(cleanText(data.assistant_ru)));
  if (assistantText) {
    parts.push(assistantText);
    const confidenceLine = buildConfidenceLine(data.confidence);
    if (confidenceLine) {
      parts.push(confidenceLine);
    }
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
  const leafSpotChecklist = buildLeafSpotTriageChecklist(data, assistantText);
  if (leafSpotChecklist) {
    parts.push(leafSpotChecklist);
  }
  const waterStressChecklist = buildWaterStressChecklist(data, assistantText);
  if (waterStressChecklist) {
    parts.push(waterStressChecklist);
  }
  return normalizeUserFacingLanguage(compactAssistantText(dedupeSections(parts).join('\n\n'), {
    maxChars: DIAG_ASSISTANT_DETAILS_MAX_CHARS,
    maxLines: DIAG_ASSISTANT_DETAILS_MAX_LINES,
  }));
}

function buildAssistantShortText(data) {
  const assistantText = sanitizeAssistantText(data, dedupeParagraphs(cleanText(data.assistant_ru)));
  const summary = buildShortSummary(data, assistantText);
  const actions = buildShortActions(data, assistantText);
  const question = buildShortQuestion(data, assistantText);
  const diagnosisTitle = msg('diagnosis.title') || '📸 Диагноз';
  const nextTitle = msg('next.title') || '⏰ Что дальше';
  const parts = [
    `${diagnosisTitle} (кратко)\n${summary}`,
    msg('diagnosis.short_actions_title') || 'Что делать сейчас:',
    actions.map((line, idx) => `${idx + 1}) ${line}`).join('\n'),
    `${nextTitle}\n${msg('diagnosis.short_question_line', { question }) || `Уточните, пожалуйста: ${question}`}`,
  ];
  if (data.plan_missing_reason) {
    parts.push(`ℹ️ ${data.plan_missing_reason}`);
  }
  if (data.need_reshoot) {
    parts.push(
      msg('diagnosis.short_reshoot_line') ||
        'Для точного шага пришлите 1–2 уточняющих фото: макро симптома и изнанка листа.',
    );
  }
  const confidenceLine = buildConfidenceLine(data.confidence);
  if (confidenceLine) {
    parts.push(confidenceLine);
  }
  return normalizeUserFacingLanguage(compactAssistantText(dedupeSections(parts).join('\n\n'), {
    maxChars: DIAG_ASSISTANT_SHORT_MAX_CHARS,
    maxLines: DIAG_ASSISTANT_SHORT_MAX_LINES,
  }));
}

function buildAssistantText(data) {
  return buildAssistantShortText(data);
}

function buildLeafSpotTriageChecklist(data, assistantText = '') {
  if (LEAF_SPOT_CHECKLIST_HEADER_RE.test(assistantText)) {
    return '';
  }
  const sourceText = [
    assistantText,
    normalizeReasoning(data?.reasoning).join('\n'),
    cleanText(data?.disease_name_ru),
    cleanText(data?.disease),
  ]
    .filter(Boolean)
    .join('\n');
  if (!LEAF_SPOT_RE.test(sourceText)) {
    return '';
  }
  return msg('diagnosis.leaf_spot_triage_checklist');
}

function buildWaterStressChecklist(data, assistantText = '') {
  const reasoningText = normalizeReasoning(data?.reasoning).join('\n');
  const planText = [
    data?.treatment_plan?.method,
    data?.treatment_plan?.safety_note,
    data?.treatment_plan?.safety,
  ]
    .filter(Boolean)
    .join('\n');
  const sourceText = [assistantText, reasoningText, planText].filter(Boolean).join('\n');
  if (!WATER_STRESS_RE.test(sourceText) && !SOIL_FLUSH_RE.test(sourceText)) {
    return '';
  }
  const hasWaterChecklist = WATER_CHECKLIST_HEADER_RE.test(assistantText);
  const hasRootChecklist = ROOT_ROT_CHECKLIST_HEADER_RE.test(assistantText);
  const rootRotRuledOut = Boolean(data?._root_rot_ruled_out);
  const strongRootRotEvidence = !rootRotRuledOut && hasStrongRootRotEvidence(data, sourceText);
  const parts = [];
  if (!hasWaterChecklist) {
    parts.push(msg('diagnosis.water_stress_checklist'));
  }
  if (strongRootRotEvidence && !hasRootChecklist) {
    parts.push(msg('diagnosis.root_rot_checklist'));
  }
  return parts.filter(Boolean).join('\n\n');
}

function buildKeyboardLayout(data, options = {}) {
  const inline = [];
  const confidence = typeof data.confidence === 'number' ? data.confidence : 0;
  const needsRecheck = confidence < LOW_CONFIDENCE_RECHECK_THRESHOLD;
  const needsCropClarify = Boolean(data.need_clarify_crop);
  const shouldHideHardCta = needsRecheck || needsCropClarify;
  const isSuccessful = confidence >= LOW_CONFIDENCE_RECHECK_THRESHOLD;

  if (data.need_clarify_crop && Array.isArray(data.clarify_crop_variants) && data.clarify_crop_variants.length) {
    const clarifyRow = data.clarify_crop_variants.slice(0, 4).map((variant, idx) => ({
      text: variant,
      callback_data: `clarify_crop|${idx}`,
    }));
    inline.push(clarifyRow);
  }
  if (!shouldHideHardCta) {
    const planCallback = options.diagnosisId
      ? `plan_treatment|${options.diagnosisId}`
      : 'plan_treatment';
    inline.push([{ text: msg('cta.schedule'), callback_data: planCallback }]);
    inline.push([{ text: msg('cta.ask_products'), callback_data: 'ask_products' }]);
  }
  const assistantCta = msg('cta.ask_assistant');
  if (assistantCta) {
    inline.push([{ text: assistantCta, callback_data: 'assistant_entry' }]);
  }
  const followupCta = msg('cta.followup');
  if (followupCta && options.diagnosisId) {
    inline.push([{ text: followupCta, callback_data: `diag_followup|${options.diagnosisId}` }]);
  }
  const detailsCta = msg('cta.details');
  if (detailsCta && options.diagnosisId) {
    inline.push([{ text: detailsCta, callback_data: `diag_details|${options.diagnosisId}` }]);
  }
  if (data.need_reshoot) {
    inline.push([{ text: msg('cta.reshoot'), callback_data: 'reshoot_photo' }]);
  }

  // Marketing: Share button for successful diagnoses
  if (isSuccessful && !options.hideShare) {
    const shareText = msg('share.button') || '📤 Поделиться';
    const diagId = options.diagnosisId || data.diagnosis_id || '';
    inline.push([{ text: shareText, callback_data: `share_diag:${diagId}` }]);
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

function formatFaqAnswer(intentId, data, options = {}) {
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
      return normalizeUserFacingLanguage(res.join('\n\n'));
    }
    case 'regional_products': {
      const region = cleanText(options?.region);
      const regionalIntro = region
        ? msg('faq.regional_products.answer_with_region', { region })
        : msg('faq.regional_products.answer');
      return normalizeUserFacingLanguage([regionalIntro, planSummary || '', msg('faq.card.tail')]
        .filter(Boolean)
        .join('\n\n'));
    }
    case 'safety_eat': {
      const phi = data?.treatment_plan?.phi_days ?? data?.treatment_plan?.phi ?? '…';
      return normalizeUserFacingLanguage(msg('faq.safety_eat.answer', { phi_days: phi }));
    }
    case 'after_treatment':
      return normalizeUserFacingLanguage(msg('faq.after_treatment.answer'));
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

function defaultFollowupAnswer(keyword, options = {}) {
  const rootRotRuledOut = Boolean(options.rootRotRuledOut);
  if (rootRotRuledOut) {
    return (
      msg('diagnosis.root_rot_ruled_out_followup') ||
      'Поняла: признаки гнили не подтверждены. Держим щадящий режим ухода и наблюдаем динамику.'
    );
  }
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

function updateRootRotSessionFlag(diag, userText) {
  if (!diag || typeof diag !== 'object') return false;
  const text = normalizeShortReply(userText);
  if (!text) return Boolean(diag._root_rot_ruled_out);
  const hasNegation = ROOT_ROT_NEGATION_RE.test(text);
  const hasStrongRiskSignal = ROOT_ROT_STRONG_SIGNAL_RE.test(text) && !NO_SMELL_RE.test(text);
  if (hasNegation && !hasStrongRiskSignal) {
    diag._root_rot_ruled_out = true;
  } else if (hasStrongRiskSignal) {
    diag._root_rot_ruled_out = false;
  }
  return Boolean(diag._root_rot_ruled_out);
}

function hasWaterSoilContext(diag) {
  const sourceText = [
    cleanText(diag?.assistant_ru),
    normalizeReasoning(diag?.reasoning).join('\n'),
    cleanText(diag?.disease_name_ru),
    cleanText(diag?.disease),
    cleanText(diag?.treatment_plan?.method),
    cleanText(diag?.treatment_plan?.safety_note),
    cleanText(diag?.treatment_plan?.safety),
  ]
    .filter(Boolean)
    .join('\n');
  return WATER_SOIL_CONTEXT_RE.test(sourceText) || WATER_STRESS_RE.test(sourceText);
}

function detectWaterStatus(normalized) {
  if (WATER_STATUS_WET_RE.test(normalized)) return 'wet';
  if (WATER_STATUS_DRY_RE.test(normalized)) return 'dry';
  if (WATER_STATUS_MOIST_RE.test(normalized)) return 'moist';
  return null;
}

function detectSmellStatus(normalized) {
  if (NO_SMELL_RE.test(normalized)) return 'none';
  if (HAS_SMELL_RE.test(normalized)) return 'has';
  return null;
}

function extractWaterSoilSignals(userText) {
  const normalized = normalizeShortReply(userText);
  if (!normalized) return null;
  const status = detectWaterStatus(normalized);
  const substrate = SOIL_TYPE_RE.test(normalized);
  const smell = detectSmellStatus(normalized);
  if (!status && !substrate && !smell) {
    return null;
  }
  return { status, substrate, smell };
}

function nextWaterSoilSlot(memory = {}) {
  if (!memory.status) return 'status';
  if (!memory.substrate) return 'substrate';
  if (!memory.smell) return 'smell';
  return null;
}

function buildWaterSoilSlotPrompt(slot) {
  if (slot === 'status') {
    return (
      msg('diagnosis.water_soil_memory_need_status') ||
      'Уточните текущую влажность на глубине 2–3 см: сухо / слегка влажно / мокро.'
    );
  }
  if (slot === 'substrate') {
    return (
      msg('diagnosis.water_soil_memory_need_substrate') ||
      'Коротко напишите состав грунта (торф/минеральный/перлит/кора).'
    );
  }
  if (slot === 'smell') {
    return (
      msg('diagnosis.water_soil_memory_need_smell') ||
      'Есть ли кислый/затхлый запах от грунта?'
    );
  }
  return null;
}

function mergeWaterSoilMemory(diag, userText, options = {}) {
  const current = diag && typeof diag._water_soil_memory === 'object' ? diag._water_soil_memory : {};
  const signals = extractWaterSoilSignals(userText) || {};
  const normalized = normalizeShortReply(userText);
  const expectedSlot = options.expectedSlot || nextWaterSoilSlot(current);
  if (!signals.smell && expectedSlot === 'smell') {
    if (SIMPLE_NO_RE.test(normalized)) {
      signals.smell = 'none';
    } else if (SIMPLE_YES_RE.test(normalized)) {
      signals.smell = 'has';
    }
  }
  const next = { ...current };
  if (signals.status) next.status = signals.status;
  if (signals.substrate) next.substrate = true;
  if (signals.smell) next.smell = signals.smell;
  if (diag && (signals.status || signals.substrate || signals.smell)) {
    diag._water_soil_memory = next;
    diag._water_soil_expected_slot = nextWaterSoilSlot(next);
  }
  return { memory: next, signals };
}

function buildWaterSoilMemoryReply(memory, signals) {
  const ack = [];
  if (signals.status === 'wet') ack.push(msg('diagnosis.water_soil_memory_ack_wet') || 'Принял: сейчас «мокро».');
  if (signals.status === 'dry') ack.push(msg('diagnosis.water_soil_memory_ack_dry') || 'Принял: сейчас «сухо».');
  if (signals.status === 'moist') ack.push(msg('diagnosis.water_soil_memory_ack_moist') || 'Принял: сейчас «слегка влажно».');
  if (signals.substrate) {
    ack.push(msg('diagnosis.water_soil_memory_ack_substrate') || 'Состав грунта отметил.');
  }
  if (signals.smell === 'none') {
    ack.push(msg('diagnosis.water_soil_memory_ack_no_smell') || 'Запаха нет — хорошо.');
  }
  if (signals.smell === 'has') {
    ack.push(msg('diagnosis.water_soil_memory_ack_has_smell') || 'Запах отметил как риск перелива.');
  }

  const missing = [];
  if (!memory.status) {
    missing.push(
      msg('diagnosis.water_soil_memory_need_status') ||
        'Уточните текущую влажность на 2–3 см: сухо / слегка влажно / мокро.',
    );
  }
  if (!memory.substrate) {
    missing.push(
      msg('diagnosis.water_soil_memory_need_substrate') ||
        'Коротко напишите состав грунта (торф/минеральный/перлит/кора).',
    );
  }
  if (!memory.smell) {
    missing.push(
      msg('diagnosis.water_soil_memory_need_smell') ||
        'Есть ли кислый/затхлый запах от грунта?',
    );
  }

  if (!missing.length) {
    return normalizeUserFacingLanguage(
      [ack.join(' '), msg('diagnosis.water_soil_memory_ready') || 'Данных достаточно: держим щадящий режим и наблюдаем 5–7 дней.']
        .filter(Boolean)
        .join('\n'),
    );
  }
  return normalizeUserFacingLanguage([ack.join(' '), missing[0]].filter(Boolean).join('\n'));
}

function resolveWaterSoilFollowup(diag, userText, options = {}) {
  const normalized = normalizeShortReply(userText);
  if (!normalized) return null;
  const hasContext = hasWaterSoilContext(diag);
  const expectedSlot = diag?._water_soil_expected_slot || nextWaterSoilSlot(diag?._water_soil_memory || {});
  const memoryBundle = options.useMemory ? mergeWaterSoilMemory(diag, userText, { expectedSlot }) : null;
  const hasSignals = Boolean(memoryBundle?.signals && (memoryBundle.signals.status || memoryBundle.signals.substrate || memoryBundle.signals.smell));
  if (!hasContext && !SOIL_TYPE_RE.test(normalized) && !hasSignals) {
    return null;
  }
  if (options.useMemory && hasSignals) {
    return buildWaterSoilMemoryReply(memoryBundle.memory, memoryBundle.signals);
  }
  if (SOIL_TYPE_RE.test(normalized)) {
    return msg('diagnosis.water_soil_followup_substrate');
  }
  if (WATER_STATUS_WET_RE.test(normalized)) {
    return msg('diagnosis.water_soil_followup_wet');
  }
  if (WATER_STATUS_DRY_RE.test(normalized)) {
    return msg('diagnosis.water_soil_followup_dry');
  }
  if (WATER_STATUS_MOIST_RE.test(normalized)) {
    return msg('diagnosis.water_soil_followup_moist');
  }
  if (options.useMemory && hasContext) {
    const slotPrompt = buildWaterSoilSlotPrompt(expectedSlot);
    if (slotPrompt) {
      if (diag && !diag._water_soil_expected_slot) {
        diag._water_soil_expected_slot = expectedSlot;
      }
      return normalizeUserFacingLanguage(slotPrompt);
    }
  }
  return null;
}

function pickAssistantFollowup(diag, keyword) {
  if (!diag?.assistant_followups_ru || !diag.assistant_followups_ru.length) return null;
  if (!keyword) return null;
  const lowerKey = keyword.toLowerCase();
  const matched = diag.assistant_followups_ru.find((line) =>
    line.toLowerCase().includes(lowerKey.slice(0, 4)),
  );
  return matched || diag.assistant_followups_ru[0];
}

function resolveFollowupReply(diag, userText, options = {}) {
  const normalizedUserText = normalizeShortReply(userText);
  const rootRotRuledOut = options.useMemory
    ? updateRootRotSessionFlag(diag, userText)
    : Boolean(diag?._root_rot_ruled_out);
  const rootRotRuledOutReply =
    msg('diagnosis.root_rot_ruled_out_followup') ||
    'Поняла: признаки гнили не подтверждены. Держим щадящий режим ухода и наблюдаем динамику.';
  const rootRotRuledOutKey = normalizeLineKey(rootRotRuledOutReply);
  if (rootRotRuledOut && ROOT_ROT_EXPLICIT_NEGATION_RE.test(normalizedUserText)) {
    if (options.useMemory && diag && rootRotRuledOutKey) {
      diag._followup_last_reply_key = rootRotRuledOutKey;
    }
    return normalizeUserFacingLanguage(rootRotRuledOutReply);
  }
  const waterSoilReply = resolveWaterSoilFollowup(diag, userText, options);
  if (waterSoilReply) {
    const key = normalizeLineKey(waterSoilReply);
    if (options.useMemory && diag && key && diag._followup_last_reply_key === key) {
      return normalizeUserFacingLanguage(
        (
        msg('diagnosis.followup_repeat_ack') ||
        'Приняла, эту часть уже учла. Давайте дальше по текущему плану.'
        ),
      );
    }
    if (options.useMemory && diag && key) {
      diag._followup_last_reply_key = key;
    }
    return normalizeUserFacingLanguage(waterSoilReply);
  }
  const keyword = extractKeyword(userText || '');
  const assistantReply = pickAssistantFollowup(diag, keyword);
  let reply = assistantReply || defaultFollowupAnswer(keyword, { rootRotRuledOut });
  if (rootRotRuledOut && CHEMICAL_ACTION_RE.test(reply || '')) {
    reply = rootRotRuledOutReply;
  }
  const key = normalizeLineKey(reply || '');
  if (options.useMemory && diag && key && diag._followup_last_reply_key === key) {
    if (rootRotRuledOut && key === rootRotRuledOutKey) {
      return normalizeUserFacingLanguage(reply);
    }
    return normalizeUserFacingLanguage(
      (
      msg('diagnosis.followup_repeat_ack') ||
      'Приняла, эту часть уже учла. Давайте дальше по текущему плану.'
      ),
    );
  }
  if (options.useMemory && diag && key) {
    diag._followup_last_reply_key = key;
  }
  return normalizeUserFacingLanguage(reply);
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
  LOW_CONFIDENCE_RECHECK_THRESHOLD,
  buildAssistantText,
  buildAssistantShortText,
  buildAssistantDetailsText,
  buildKeyboardLayout,
  detectFaqIntent,
  formatFaqAnswer,
  resolveFollowupReply,
  FAQ_INTENTS,
};
