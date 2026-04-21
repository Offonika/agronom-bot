'use strict';

const { msg } = require('./utils');

const QA_SESSION_TTL_MS = Number(process.env.QA_INTAKE_SESSION_TTL_MS || 20 * 60 * 1000);
const QA_EVENT_TYPE = process.env.QA_INTAKE_EVENT_TYPE || 'qa_case_logged';
const QA_DIAG_LINK_MAX_AGE_H = Number(process.env.QA_INTAKE_DIAG_MAX_AGE_H || '72');

const KNOWN_SCENARIOS = [
  'new_diagnosis',
  'followup_photo',
  'ask_products',
  'assistant_chat',
  'pending_retry',
];

const KNOWN_ERROR_TYPES = [
  'none',
  'wrong_class',
  'wrong_risk',
  'wrong_action',
  'context_lost',
  'ux_dead_end',
  'hallucination',
  'other',
];

const SCENARIO_OPTIONS = [
  { code: 'new_diagnosis', labelKey: 'qa_intake_scenario_new_diagnosis' },
  { code: 'followup_photo', labelKey: 'qa_intake_scenario_followup_photo' },
  { code: 'ask_products', labelKey: 'qa_intake_scenario_ask_products' },
  { code: 'assistant_chat', labelKey: 'qa_intake_scenario_assistant_chat' },
  { code: 'pending_retry', labelKey: 'qa_intake_scenario_pending_retry' },
];

const ERROR_OPTIONS = [
  { code: 'none', labelKey: 'qa_intake_error_none' },
  { code: 'wrong_class', labelKey: 'qa_intake_error_wrong_class' },
  { code: 'wrong_risk', labelKey: 'qa_intake_error_wrong_risk' },
  { code: 'wrong_action', labelKey: 'qa_intake_error_wrong_action' },
  { code: 'context_lost', labelKey: 'qa_intake_error_context_lost' },
  { code: 'ux_dead_end', labelKey: 'qa_intake_error_ux_dead_end' },
  { code: 'hallucination', labelKey: 'qa_intake_error_hallucination' },
  { code: 'other', labelKey: 'qa_intake_error_other' },
];

const SEVERITY_OPTIONS = [
  { code: 'S1', labelKey: 'qa_intake_severity_s1' },
  { code: 'S2', labelKey: 'qa_intake_severity_s2' },
  { code: 'S3', labelKey: 'qa_intake_severity_s3' },
];

const DETAIL_FIELDS = {
  plant: 'qa_intake_field_plant',
  expected: 'qa_intake_field_expected',
  actual: 'qa_intake_field_actual',
  notes: 'qa_intake_field_notes',
  confidence: 'qa_intake_field_confidence',
  diagnosis: 'qa_intake_field_diagnosis',
};

function parseNumberList(raw) {
  if (!raw) return new Set();
  return new Set(
    String(raw)
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => Number(item))
      .filter((item) => Number.isFinite(item)),
  );
}

function parseStringList(raw) {
  if (!raw) return new Set();
  return new Set(
    String(raw)
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean),
  );
}

function normalizeSeverity(value) {
  const m = String(value || '').match(/\bS\s*([123])\b/i);
  return m ? `S${m[1]}` : null;
}

function normalizeScenario(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return null;
  if (KNOWN_SCENARIOS.includes(raw)) return raw;
  if (raw.includes('досыл') || raw.includes('followup')) return 'followup_photo';
  if (raw.includes('нов') || raw.includes('new')) return 'new_diagnosis';
  if (raw.includes('ассист') || raw.includes('assistant') || raw.includes('чат')) return 'assistant_chat';
  if (raw.includes('препарат') || raw.includes('product')) return 'ask_products';
  if (raw.includes('pending') || raw.includes('retry') || raw.includes('очеред') || raw.includes('ожид')) {
    return 'pending_retry';
  }
  return null;
}

function normalizeErrorType(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return null;
  if (KNOWN_ERROR_TYPES.includes(raw)) return raw;
  if (raw.includes('нет ошиб') || raw === 'нет') return 'none';
  if (raw.includes('context') || raw.includes('контекст')) return 'context_lost';
  if (raw.includes('ux') || raw.includes('dead') || raw.includes('тупик') || raw.includes('затык')) {
    return 'ux_dead_end';
  }
  if (raw.includes('halluc') || raw.includes('галлюц') || raw.includes('выдум')) return 'hallucination';
  if (raw.includes('risk') || raw.includes('риск')) return 'wrong_risk';
  if (raw.includes('action') || raw.includes('действ')) return 'wrong_action';
  if (raw.includes('class') || raw.includes('иденти') || raw.includes('класс')) return 'wrong_class';
  if (raw.includes('другое') || raw.includes('other')) return 'other';
  return null;
}

function extractConfidence(value, options = {}) {
  const { allowPlain = false } = options;
  const toPercent = (raw, explicitPercent = false) => {
    const numeric = Number(raw);
    if (!Number.isFinite(numeric)) return null;
    const normalized = explicitPercent ? numeric : numeric <= 1 ? numeric * 100 : numeric;
    if (!Number.isFinite(normalized)) return null;
    return `${Math.round(Math.max(0, Math.min(100, normalized)))}%`;
  };

  if (typeof value === 'number' && Number.isFinite(value)) {
    return toPercent(value, false);
  }

  const text = String(value || '').trim().replace(',', '.');
  if (!text) return null;

  const percentMatch = text.match(/(\d{1,3}(?:\.\d+)?)\s*%/);
  if (percentMatch) {
    return toPercent(percentMatch[1], true);
  }

  if (!allowPlain) return null;
  const plainMatch = text.match(/^(\d{1,3}(?:\.\d+)?)$/);
  if (!plainMatch) return null;
  return toPercent(plainMatch[1], false);
}

function extractConfidenceFromDiagnosis(record) {
  if (!record || typeof record !== 'object') return null;
  const payload = record.diagnosis_payload && typeof record.diagnosis_payload === 'object' ? record.diagnosis_payload : null;
  return extractConfidence(payload?.confidence, { allowPlain: true });
}

function extractDiagnosisId(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  const m = text.match(/\b(\d{1,12})\b/);
  if (!m) return null;
  const id = Number(m[1]);
  return Number.isFinite(id) && id > 0 ? id : null;
}

function cleanupText(value) {
  const text = String(value || '').trim();
  return text || null;
}

function parsePipeFormat(raw) {
  const parts = String(raw)
    .split('|')
    .map((item) => item.trim())
    .filter(Boolean);
  if (parts.length < 6) return null;

  let idx = 0;
  let caseId = null;
  if (/^(?:RT|QA)[-_]?\d+/i.test(parts[0])) {
    caseId = parts[0];
    idx += 1;
  }

  const plant = cleanupText(parts[idx++]);
  const scenario = normalizeScenario(parts[idx++]);
  const severity = normalizeSeverity(parts[idx++]);
  const errorType = normalizeErrorType(parts[idx++]);
  const expected = cleanupText(parts[idx++]);
  const actual = cleanupText(parts[idx++]);
  const notes = cleanupText(parts.slice(idx).join(' | '));

  return {
    caseId,
    diagnosisId: extractDiagnosisId(raw),
    plant,
    scenario,
    severity,
    errorType,
    expected,
    actual,
    notes,
    confidence: extractConfidence(raw),
  };
}

function normalizeKvKey(raw) {
  const key = String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/[()]/g, '')
    .replace(/\s+/g, '');
  if (['id', 'caseid', 'idкейса', 'кейс', 'кейc'].includes(key)) return 'caseId';
  if (['diagid', 'diagnosisid', 'diagnosis_id', 'idдиагноза'].includes(key)) return 'diagnosisId';
  if (['растение', 'plant', 'crop', 'культура'].includes(key)) return 'plant';
  if (['сценарий', 'scenario'].includes(key)) return 'scenario';
  if (['критичность', 'severity', 'приоритет'].includes(key)) return 'severity';
  if (['типошибки', 'error', 'errortype', 'ошибка'].includes(key)) return 'errorType';
  if (['ожидаемое', 'expected', 'ожидание'].includes(key)) return 'expected';
  if (['факт', 'actual', 'фактическое'].includes(key)) return 'actual';
  if (['уверенность', 'confidence'].includes(key)) return 'confidence';
  if (['заметки', 'notes', 'комментарий'].includes(key)) return 'notes';
  return null;
}

function parseKeyValueFormat(raw) {
  const lines = String(raw)
    .split(/[\n;]+/)
    .map((item) => item.trim())
    .filter(Boolean);
  if (!lines.length) return null;
  const result = {};

  for (const line of lines) {
    const m = line.match(/^([^:=]+)\s*[:=]\s*(.+)$/);
    if (!m) continue;
    const key = normalizeKvKey(m[1]);
    if (!key) continue;
    result[key] = m[2].trim();
  }

  if (!Object.keys(result).length) return null;

  return {
    caseId: cleanupText(result.caseId),
    diagnosisId: extractDiagnosisId(result.diagnosisId),
    plant: cleanupText(result.plant),
    scenario: normalizeScenario(result.scenario),
    severity: normalizeSeverity(result.severity),
    errorType: normalizeErrorType(result.errorType),
    expected: cleanupText(result.expected),
    actual: cleanupText(result.actual),
    notes: cleanupText(result.notes),
    confidence: extractConfidence(result.confidence, { allowPlain: true }),
  };
}

function parseQaCaseText(rawText) {
  const raw = String(rawText || '')
    .replace(/^#qa\s*/i, '')
    .replace(/^qa:\s*/i, '')
    .trim();

  const pipeParsed = parsePipeFormat(raw);
  const kvParsed = pipeParsed ? null : parseKeyValueFormat(raw);
  const parsed = pipeParsed || kvParsed || {};

  const caseIdRegex = raw.match(/\b((?:RT|QA)[-_]?\d{1,12})\b/i);
  const explicitDiagMatch = raw.match(/\b(?:diag(?:nosis)?_?id|diagnosis_id|id\s*диагноза)\s*[:=]?\s*(\d{1,12})\b/i);

  return {
    raw,
    caseId: cleanupText(parsed.caseId) || (caseIdRegex ? caseIdRegex[1] : null),
    diagnosisId:
      parsed.diagnosisId ||
      (explicitDiagMatch ? Number(explicitDiagMatch[1]) : null) ||
      (raw.includes('diag') || raw.includes('диагноз') ? extractDiagnosisId(raw) : null),
    plant: cleanupText(parsed.plant),
    scenario: parsed.scenario || normalizeScenario(raw),
    severity: parsed.severity || normalizeSeverity(raw),
    errorType: parsed.errorType || normalizeErrorType(raw),
    expected: cleanupText(parsed.expected),
    actual: cleanupText(parsed.actual),
    notes: cleanupText(parsed.notes),
    confidence: parsed.confidence || extractConfidence(raw),
  };
}

function formatMskDate(date = new Date()) {
  const parts = new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Europe/Moscow',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const get = (type) => parts.find((part) => part.type === type)?.value;
  const dd = get('day');
  const mm = get('month');
  const yyyy = get('year');
  const hh = get('hour');
  const mi = get('minute');
  const ss = get('second');
  const datePart = `${dd}.${mm}.${yyyy}`;
  const timePart = `${hh}:${mi}:${ss}`;
  return { value: `${datePart} ${timePart}`, yyyymmdd: `${yyyy}${mm}${dd}` };
}

function extractFilesFromMessage(message) {
  if (!message || typeof message !== 'object') return [];
  const refs = [];
  if (Array.isArray(message.photo) && message.photo.length) {
    const photo = message.photo[message.photo.length - 1];
    refs.push({
      type: 'photo',
      file_id: photo.file_id,
      file_unique_id: photo.file_unique_id,
    });
  }
  if (message.document?.file_id) {
    refs.push({
      type: 'document',
      file_id: message.document.file_id,
      file_unique_id: message.document.file_unique_id,
    });
  }
  return refs;
}

function dedupeFiles(files = []) {
  const out = [];
  const seen = new Set();
  for (const file of files) {
    const key = file?.file_unique_id || file?.file_id || JSON.stringify(file || {});
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(file);
  }
  return out;
}

function buildMessageLink(chat, messageId) {
  if (!chat || !messageId) return null;
  if (chat.username) {
    return `https://t.me/${chat.username}/${messageId}`;
  }
  const rawId = String(chat.id || '');
  if (!rawId.startsWith('-100')) return null;
  return `https://t.me/c/${rawId.slice(4)}/${messageId}`;
}

function collectMissingFields(parsed) {
  const required = [
    ['scenario', 'сценарий'],
    ['severity', 'критичность'],
    ['errorType', 'тип ошибки'],
  ];
  return required.filter(([key]) => !parsed[key]).map(([, label]) => label);
}

function findLabel(options, code, fallback = '—') {
  const found = options.find((item) => item.code === code);
  if (!found) return fallback;
  return msg(found.labelKey) || code;
}

function isRecentEnough(record) {
  if (!record?.created_at) return false;
  if (!Number.isFinite(QA_DIAG_LINK_MAX_AGE_H) || QA_DIAG_LINK_MAX_AGE_H <= 0) return true;
  const createdAtMs = new Date(record.created_at).getTime();
  if (!Number.isFinite(createdAtMs) || createdAtMs <= 0) return false;
  return Date.now() - createdAtMs <= QA_DIAG_LINK_MAX_AGE_H * 60 * 60 * 1000;
}

function createDraft(caseId) {
  return {
    caseId,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    awaitingField: null,
    awaitingReplyToMessageId: null,
    cardMessageId: null,
    values: {
      plant: null,
      scenario: null,
      severity: null,
      errorType: null,
      expected: null,
      actual: null,
      notes: null,
      confidence: null,
      diagnosisId: null,
    },
    files: [],
  };
}

function buildDraftText(draft) {
  return msg('qa_intake_master_card', {
    case_id: draft.caseId,
    scenario_label: `${findLabel(SCENARIO_OPTIONS, draft.values.scenario)} (${draft.values.scenario || '—'})`,
    error_label: `${findLabel(ERROR_OPTIONS, draft.values.errorType)} (${draft.values.errorType || '—'})`,
    severity_label: `${findLabel(SEVERITY_OPTIONS, draft.values.severity)} (${draft.values.severity || '—'})`,
    plant: draft.values.plant || '—',
    expected: draft.values.expected || '—',
    actual: draft.values.actual || '—',
    notes: draft.values.notes || '—',
    confidence: draft.values.confidence || '—',
    diagnosis_id: draft.values.diagnosisId || '—',
    files_count: String((draft.files || []).length),
  });
}

function buildMainKeyboard() {
  return {
    inline_keyboard: [
      [{ text: msg('qa_intake_btn_scenario'), callback_data: 'qa_menu:scn' }],
      [{ text: msg('qa_intake_btn_error_type'), callback_data: 'qa_menu:err' }],
      [{ text: msg('qa_intake_btn_severity'), callback_data: 'qa_menu:sev' }],
      [{ text: msg('qa_intake_btn_details'), callback_data: 'qa_menu:details' }],
      [
        { text: msg('qa_intake_btn_save'), callback_data: 'qa_save' },
        { text: msg('qa_intake_btn_cancel'), callback_data: 'qa_cancel' },
      ],
    ],
  };
}

function buildOptionsKeyboard(prefix, options, backData = 'qa_back') {
  return {
    inline_keyboard: [
      ...options.map((item) => [{ text: msg(item.labelKey) || item.code, callback_data: `${prefix}:${item.code}` }]),
      [{ text: msg('qa_intake_btn_back'), callback_data: backData }],
    ],
  };
}

function buildDetailsKeyboard() {
  return {
    inline_keyboard: [
      [{ text: msg('qa_intake_btn_detail_plant'), callback_data: 'qa_add:plant' }],
      [{ text: msg('qa_intake_btn_detail_expected'), callback_data: 'qa_add:expected' }],
      [{ text: msg('qa_intake_btn_detail_actual'), callback_data: 'qa_add:actual' }],
      [{ text: msg('qa_intake_btn_detail_notes'), callback_data: 'qa_add:notes' }],
      [{ text: msg('qa_intake_btn_detail_confidence'), callback_data: 'qa_add:confidence' }],
      [{ text: msg('qa_intake_btn_detail_diagnosis'), callback_data: 'qa_add:diagnosis' }],
      [{ text: msg('qa_intake_btn_back'), callback_data: 'qa_back' }],
    ],
  };
}

async function safeEditOrReply(ctx, text, replyMarkup) {
  try {
    if (typeof ctx.editMessageText === 'function') {
      await ctx.editMessageText(text, { reply_markup: replyMarkup });
      return null;
    }
  } catch (err) {
    // fallback to reply below
  }
  if (typeof ctx.reply === 'function') {
    return ctx.reply(text, { reply_markup: replyMarkup });
  }
  return null;
}

function parseDraftFieldValue(field, text) {
  const cleaned = cleanupText(text);
  if (!cleaned) return null;
  if (field === 'confidence') {
    return extractConfidence(cleaned, { allowPlain: true });
  }
  if (field === 'diagnosis') {
    return extractDiagnosisId(cleaned);
  }
  return cleaned;
}

function parseInlineCaseCandidate(text) {
  const parsed = parseQaCaseText(text);
  const hasAny =
    parsed.scenario ||
    parsed.errorType ||
    parsed.severity ||
    parsed.expected ||
    parsed.actual ||
    parsed.notes ||
    parsed.plant;
  return hasAny ? parsed : null;
}

function createQaIntake({ db }) {
  const qaChatIds = parseStringList(process.env.QA_INTAKE_CHAT_ID);
  const allowedTesterIds = parseNumberList(process.env.QA_INTAKE_TESTER_IDS);
  const drafts = new Map();

  function isQaChat(chatId) {
    if (!qaChatIds.size) return false;
    return qaChatIds.has(String(chatId));
  }

  function isTesterAllowed(userId) {
    if (!allowedTesterIds.size) return true;
    return allowedTesterIds.has(Number(userId));
  }

  function sessionKey(chatId, userId) {
    return `${chatId}:${userId}`;
  }

  function readCommandArgs(text) {
    const value = String(text || '').trim();
    const index = value.indexOf(' ');
    return index >= 0 ? value.slice(index + 1).trim() : '';
  }

  function getDraft(key) {
    const draft = drafts.get(key);
    if (!draft) return null;
    if (Date.now() - draft.updatedAt > QA_SESSION_TTL_MS) {
      drafts.delete(key);
      return null;
    }
    return draft;
  }

  function setDraft(key, draft) {
    draft.updatedAt = Date.now();
    drafts.set(key, draft);
    return draft;
  }

  function appendDraftFiles(key, message) {
    const draft = getDraft(key);
    if (!draft) return null;
    draft.files = dedupeFiles([...draft.files, ...extractFilesFromMessage(message)]);
    return setDraft(key, draft);
  }

  async function logReplyMismatch(ctx, draft) {
    if (!ctx?.from?.id || !db?.logFunnelEvent || typeof db.ensureUser !== 'function') return;
    try {
      const user = await db.ensureUser(ctx.from.id);
      if (!user?.id) return;
      await db.logFunnelEvent({
        event: 'qa_intake_reply_mismatch',
        userId: user.id,
        objectId: null,
        planId: null,
        data: {
          awaitingField: draft?.awaitingField || null,
          expectedReplyToMessageId: draft?.awaitingReplyToMessageId || null,
          actualReplyToMessageId: ctx?.message?.reply_to_message?.message_id || null,
        },
      });
    } catch (err) {
      console.error('qaIntake.reply_mismatch_log_failed', err);
    }
  }

  async function resolveDiagnosisLink(userId, parsed) {
    if (!Number.isFinite(Number(userId)) || Number(userId) <= 0) {
      return {
        diagnosisId: null,
        mode: 'none',
        confidence: 'none',
        diagnosisConfidence: null,
      };
    }

    if (parsed.diagnosisId && typeof db?.getRecentDiagnosisById === 'function') {
      try {
        const explicit = await db.getRecentDiagnosisById(userId, parsed.diagnosisId);
        if (explicit?.id) {
          return {
            diagnosisId: Number(explicit.id),
            mode: 'explicit',
            confidence: 'high',
            diagnosisConfidence: extractConfidenceFromDiagnosis(explicit),
          };
        }
      } catch (err) {
        console.error('qa_intake explicit diagnosis link failed', err);
      }
    }

    if (typeof db?.getLatestRecentDiagnosis === 'function') {
      try {
        const latest = await db.getLatestRecentDiagnosis(userId);
        if (latest?.id && isRecentEnough(latest)) {
          return {
            diagnosisId: Number(latest.id),
            mode: 'latest_recent',
            confidence: 'medium',
            diagnosisConfidence: extractConfidenceFromDiagnosis(latest),
          };
        }
      } catch (err) {
        console.error('qa_intake latest diagnosis link failed', err);
      }
    }

    return {
      diagnosisId: null,
      mode: 'none',
      confidence: 'none',
      diagnosisConfidence: null,
    };
  }

  async function persistCase(ctx, rawText, source = 'text', options = {}) {
    if (typeof db?.ensureUser !== 'function' || typeof db?.logBetaEvent !== 'function') {
      await ctx.reply(msg('qa_intake_unavailable'));
      return null;
    }

    const parsed = options.parsed || parseQaCaseText(rawText);
    const msk = formatMskDate();
    const currentMessage = ctx.message || {};
    const replyMessage = currentMessage.reply_to_message || null;
    const autoCaseId = `QA-${msk.yyyymmdd}-${currentMessage.message_id || Date.now()}`;
    const caseId = parsed.caseId || options.caseId || autoCaseId;
    const linkedFiles = dedupeFiles([
      ...(options.extraFiles || []),
      ...extractFilesFromMessage(replyMessage),
      ...extractFilesFromMessage(currentMessage),
    ]);

    const user = await db.ensureUser(ctx.from.id);
    const diagnosisLink = await resolveDiagnosisLink(user.id, parsed);

    const resolvedConfidence = parsed.confidence || diagnosisLink.diagnosisConfidence || null;
    const payload = {
      case_id: caseId,
      tester_tg_id: ctx.from?.id || null,
      tester_username: ctx.from?.username || null,
      tester_name: [ctx.from?.first_name, ctx.from?.last_name].filter(Boolean).join(' ') || null,
      chat_id: ctx.chat?.id || null,
      chat_type: ctx.chat?.type || null,
      message_id: currentMessage.message_id || null,
      reply_to_message_id: replyMessage?.message_id || null,
      message_link: buildMessageLink(ctx.chat, currentMessage.message_id),
      created_at_msk: msk.value,
      source,
      plant: parsed.plant,
      scenario: parsed.scenario,
      severity: parsed.severity,
      error_type: parsed.errorType,
      confidence: resolvedConfidence,
      expected: parsed.expected,
      actual: parsed.actual,
      notes: parsed.notes,
      raw_text: cleanupText(rawText) || null,
      files: linkedFiles,
      diagnosis_id: diagnosisLink.diagnosisId,
      diagnosis_link_mode: diagnosisLink.mode,
      diagnosis_link_confidence: diagnosisLink.confidence,
    };

    await db.logBetaEvent({
      userId: user.id,
      eventType: QA_EVENT_TYPE,
      payload,
    });

    const missing = collectMissingFields(parsed);
    const missingText = missing.length ? msg('qa_intake_missing_fields', { fields: missing.join(', ') }) : null;

    const lines = [
      msg('qa_intake_saved', {
        case_id: caseId,
        scenario: `${findLabel(SCENARIO_OPTIONS, parsed.scenario)} (${parsed.scenario || '—'})`,
        severity: `${findLabel(SEVERITY_OPTIONS, parsed.severity)} (${parsed.severity || '—'})`,
        error_type: `${findLabel(ERROR_OPTIONS, parsed.errorType)} (${parsed.errorType || '—'})`,
      }),
    ];
    if (missingText) lines.push(missingText);
    await ctx.reply(lines.filter(Boolean).join('\n'));

    return payload;
  }

  async function openWizard(ctx, draft) {
    const text = buildDraftText(draft);
    const sent = await ctx.reply(text, { reply_markup: buildMainKeyboard() });
    if (sent?.message_id) {
      draft.cardMessageId = sent.message_id;
    }
    return draft;
  }

  async function handleCommand(ctx) {
    if (!isQaChat(ctx.chat?.id)) return false;
    if (!isTesterAllowed(ctx.from?.id)) {
      await ctx.reply(msg('qa_intake_not_allowed'));
      return true;
    }

    const args = readCommandArgs(ctx.message?.text);
    const chatId = ctx.chat?.id;
    const userId = ctx.from?.id;
    const key = sessionKey(chatId, userId);

    if (!args) {
      const caseId = `QA-${formatMskDate().yyyymmdd}-${ctx.message?.message_id || Date.now()}`;
      const draft = setDraft(key, createDraft(caseId));
      await openWizard(ctx, draft);
      return true;
    }

    if (/^(help|\?|помощь)$/i.test(args)) {
      await ctx.reply(msg('qa_intake_help'));
      return true;
    }

    if (/^(cancel|отмена)$/i.test(args)) {
      drafts.delete(key);
      await ctx.reply(msg('qa_intake_cancelled'));
      return true;
    }

    drafts.delete(key);
    await persistCase(ctx, args, 'command');
    return true;
  }

  async function handleCallback(ctx) {
    if (!isQaChat(ctx.chat?.id)) return false;
    if (!isTesterAllowed(ctx.from?.id)) {
      await ctx.answerCbQuery(msg('qa_intake_not_allowed'));
      return true;
    }
    const data = String(ctx.callbackQuery?.data || '');
    if (!data.startsWith('qa_')) return false;

    const key = sessionKey(ctx.chat?.id, ctx.from?.id);
    let draft = getDraft(key);
    if (!draft && data !== 'qa_cancel') {
      await ctx.answerCbQuery(msg('qa_intake_session_expired'));
      return true;
    }

    await ctx.answerCbQuery();

    if (draft?.awaitingField && data !== 'qa_cancel') {
      await ctx.reply(msg('qa_intake_reply_required'));
      return true;
    }

    if (data === 'qa_cancel') {
      drafts.delete(key);
      await safeEditOrReply(ctx, msg('qa_intake_cancelled'), null);
      return true;
    }

    if (data === 'qa_back') {
      await safeEditOrReply(ctx, buildDraftText(draft), buildMainKeyboard());
      return true;
    }

    if (data === 'qa_menu:scn') {
      await safeEditOrReply(ctx, msg('qa_intake_pick_scenario'), buildOptionsKeyboard('qa_scn', SCENARIO_OPTIONS));
      return true;
    }

    if (data === 'qa_menu:err') {
      await safeEditOrReply(ctx, msg('qa_intake_pick_error_type'), buildOptionsKeyboard('qa_err', ERROR_OPTIONS));
      return true;
    }

    if (data === 'qa_menu:sev') {
      await safeEditOrReply(ctx, msg('qa_intake_pick_severity'), buildOptionsKeyboard('qa_sev', SEVERITY_OPTIONS));
      return true;
    }

    if (data === 'qa_menu:details') {
      await safeEditOrReply(ctx, msg('qa_intake_pick_detail_field'), buildDetailsKeyboard());
      return true;
    }

    if (data.startsWith('qa_scn:')) {
      const value = data.slice('qa_scn:'.length);
      if (KNOWN_SCENARIOS.includes(value)) {
        draft.values.scenario = value;
        draft.awaitingField = null;
        draft.awaitingReplyToMessageId = null;
        setDraft(key, draft);
      }
      await safeEditOrReply(ctx, buildDraftText(draft), buildMainKeyboard());
      return true;
    }

    if (data.startsWith('qa_err:')) {
      const value = data.slice('qa_err:'.length);
      if (KNOWN_ERROR_TYPES.includes(value)) {
        draft.values.errorType = value;
        draft.awaitingField = null;
        draft.awaitingReplyToMessageId = null;
        setDraft(key, draft);
      }
      await safeEditOrReply(ctx, buildDraftText(draft), buildMainKeyboard());
      return true;
    }

    if (data.startsWith('qa_sev:')) {
      const value = data.slice('qa_sev:'.length).toUpperCase();
      if (['S1', 'S2', 'S3'].includes(value)) {
        draft.values.severity = value;
        draft.awaitingField = null;
        draft.awaitingReplyToMessageId = null;
        setDraft(key, draft);
      }
      await safeEditOrReply(ctx, buildDraftText(draft), buildMainKeyboard());
      return true;
    }

    if (data.startsWith('qa_add:')) {
      const field = data.slice('qa_add:'.length);
      if (!Object.prototype.hasOwnProperty.call(DETAIL_FIELDS, field)) {
        return true;
      }
      draft.awaitingField = field;
      const label = msg(DETAIL_FIELDS[field]) || field;
      const prompt = await ctx.reply(msg('qa_intake_field_prompt', { field: label }));
      draft.awaitingReplyToMessageId = prompt?.message_id || null;
      setDraft(key, draft);
      return true;
    }

    if (data === 'qa_save') {
      const parsed = {
        caseId: draft.caseId,
        diagnosisId: draft.values.diagnosisId,
        plant: draft.values.plant,
        scenario: draft.values.scenario,
        severity: draft.values.severity,
        errorType: draft.values.errorType,
        expected: draft.values.expected,
        actual: draft.values.actual,
        notes: draft.values.notes,
        confidence: draft.values.confidence,
      };
      const missing = collectMissingFields(parsed);
      if (missing.length) {
        await ctx.reply(msg('qa_intake_missing_fields', { fields: missing.join(', ') }));
        return true;
      }
      drafts.delete(key);
      await persistCase(
        ctx,
        [
          `case_id: ${draft.caseId}`,
          `scenario: ${draft.values.scenario || ''}`,
          `severity: ${draft.values.severity || ''}`,
          `error_type: ${draft.values.errorType || ''}`,
          `plant: ${draft.values.plant || ''}`,
          `expected: ${draft.values.expected || ''}`,
          `actual: ${draft.values.actual || ''}`,
          `notes: ${draft.values.notes || ''}`,
          `confidence: ${draft.values.confidence || ''}`,
          `diagnosis_id: ${draft.values.diagnosisId || ''}`,
        ]
          .filter(Boolean)
          .join('\n'),
        'wizard',
        {
          caseId: draft.caseId,
          parsed,
          extraFiles: draft.files,
        },
      );
      await safeEditOrReply(ctx, msg('qa_intake_saved_from_wizard', { case_id: draft.caseId }), null);
      return true;
    }

    return true;
  }

  async function handleText(ctx) {
    if (!isQaChat(ctx.chat?.id)) return false;
    if (!isTesterAllowed(ctx.from?.id)) return true;

    const text = ctx.message?.text?.trim();
    if (!text || text.startsWith('/')) return false;

    const explicitCase = /^#qa\b/i.test(text) || /^qa:\s*/i.test(text);
    const key = sessionKey(ctx.chat?.id, ctx.from?.id);
    const draft = getDraft(key);

    if (explicitCase) {
      if (draft) drafts.delete(key);
      await persistCase(ctx, text, 'hashtag', { extraFiles: draft?.files || [] });
      return true;
    }

    if (!draft) return false;

    if (draft.awaitingField) {
      const expectedReplyId = Number(draft.awaitingReplyToMessageId);
      const actualReplyId = Number(ctx.message?.reply_to_message?.message_id);
      if (!expectedReplyId || !actualReplyId || expectedReplyId !== actualReplyId) {
        await logReplyMismatch(ctx, draft);
        await ctx.reply(msg('qa_intake_reply_required'));
        return true;
      }
      const value = parseDraftFieldValue(draft.awaitingField, text);
      if (!value) {
        const label = msg(DETAIL_FIELDS[draft.awaitingField]) || draft.awaitingField;
        await ctx.reply(msg('qa_intake_field_invalid', { field: label }));
        return true;
      }
      if (draft.awaitingField === 'confidence') {
        draft.values.confidence = value;
      } else if (draft.awaitingField === 'diagnosis') {
        draft.values.diagnosisId = value;
      } else {
        draft.values[draft.awaitingField] = value;
      }
      draft.awaitingField = null;
      draft.awaitingReplyToMessageId = null;
      setDraft(key, draft);
      await ctx.reply(buildDraftText(draft), { reply_markup: buildMainKeyboard() });
      return true;
    }

    const inlineParsed = parseInlineCaseCandidate(text);
    if (inlineParsed) {
      drafts.delete(key);
      await persistCase(ctx, text, 'session', { extraFiles: draft.files });
      return true;
    }

    await ctx.reply(msg('qa_intake_use_buttons'));
    return true;
  }

  async function handlePhoto(ctx) {
    if (!isQaChat(ctx.chat?.id)) return false;
    if (!isTesterAllowed(ctx.from?.id)) return true;

    const key = sessionKey(ctx.chat?.id, ctx.from?.id);
    const draft = appendDraftFiles(key, ctx.message);
    const caption = String(ctx.message?.caption || '').trim();
    const explicitCase = /^#qa\b/i.test(caption) || /^qa:\s*/i.test(caption);

    if (explicitCase) {
      drafts.delete(key);
      await persistCase(ctx, caption, 'photo_caption', { extraFiles: draft?.files || [] });
      return true;
    }

    if (draft) {
      await ctx.reply(msg('qa_intake_photo_attached', { files_count: String(draft.files.length) }));
      return true;
    }

    return false;
  }

  async function handleAnyMessage(ctx) {
    if (!isQaChat(ctx.chat?.id)) return false;
    if (!isTesterAllowed(ctx.from?.id)) return true;

    const message = ctx.message || {};
    if (message.text || message.photo) return false;

    const key = sessionKey(ctx.chat?.id, ctx.from?.id);
    const draft = appendDraftFiles(key, message);

    const caption = String(message.caption || '').trim();
    const explicitCase = /^#qa\b/i.test(caption) || /^qa:\s*/i.test(caption);

    if (caption && explicitCase) {
      drafts.delete(key);
      await persistCase(ctx, caption, 'caption', { extraFiles: draft?.files || [] });
      return true;
    }

    if (draft && extractFilesFromMessage(message).length) {
      await ctx.reply(msg('qa_intake_file_attached', { files_count: String(draft.files.length) }));
      return true;
    }

    return false;
  }

  return {
    isQaChat,
    handleCommand,
    handleCallback,
    handleText,
    handlePhoto,
    handleAnyMessage,
    parseQaCaseText,
  };
}

module.exports = {
  createQaIntake,
  parseQaCaseText,
};
