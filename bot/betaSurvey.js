'use strict';

const { msg } = require('./utils');
const { isAwaitingRegionAsync } = require('./regionPromptState');

const pendingComments = new Map();
const DEFAULT_COMMENT_TTL_MS = 10 * 60 * 1000;
const parsedCommentTtl = Number(process.env.BETA_SURVEY_COMMENT_TTL_MS || DEFAULT_COMMENT_TTL_MS);
const COMMENT_TTL_MS = Number.isFinite(parsedCommentTtl) && parsedCommentTtl > 0
  ? parsedCommentTtl
  : DEFAULT_COMMENT_TTL_MS;
const COMMENT_EXPIRED_GRACE_MS = Number(process.env.BETA_SURVEY_COMMENT_EXPIRED_GRACE_MS || '300000');
const COMMENT_REDIS_KEY_PREFIX = process.env.BETA_SURVEY_COMMENT_REDIS_PREFIX || 'bot:beta_survey_comment:';
const pendingQ2Prompts = new Map();
const Q2_PROMPT_TTL_MS = 2 * 60 * 1000;
const SURVEY_BYPASS_RE =
  /(регион|область|край|республика|город|препарат|чем\s+обработ|подбери|подобра|диагноз|болезн|лечение|план)/i;
const REGION_REPLY_PROMPT_RE = /(назов[её]шь\s+регион|подбер[еу]\s+разреш[её]нн|препарат)/i;
const REGION_TEXT_RE = /^[\p{L}\s\-.,]{2,64}$/u;
let redisClient = null;
let commentRedisKeyPrefix = COMMENT_REDIS_KEY_PREFIX;

function __getPendingComments() {
  return pendingComments;
}

function configurePersistence(options = {}) {
  redisClient = options.redis || null;
  commentRedisKeyPrefix =
    typeof options.commentKeyPrefix === 'string' && options.commentKeyPrefix.trim()
      ? options.commentKeyPrefix.trim()
      : COMMENT_REDIS_KEY_PREFIX;
}

function getCommentRedisKey(userId) {
  if (!userId) return null;
  return `${commentRedisKeyPrefix}${userId}`;
}

function restorePendingComment(raw, userId = null) {
  if (!raw || typeof raw !== 'object') return null;
  const feedbackId = Number(raw.feedbackId);
  const createdAt = Number(raw.createdAt || Date.now());
  if (!Number.isFinite(feedbackId) || feedbackId <= 0) return null;
  if (!Number.isFinite(createdAt) || Date.now() - createdAt > COMMENT_TTL_MS) return null;
  return {
    userId: raw.userId || userId || null,
    feedbackId,
    createdAt,
  };
}

async function persistPendingComment(userId, entry) {
  if (!redisClient || !userId) return;
  const key = getCommentRedisKey(userId);
  if (!key) return;
  if (!entry) {
    try {
      await redisClient.del(key);
    } catch (err) {
      console.error('betaSurvey persist comment delete failed', err);
    }
    return;
  }
  const ttlMs = Math.max(1000, entry.createdAt + COMMENT_TTL_MS - Date.now() + COMMENT_EXPIRED_GRACE_MS);
  try {
    await redisClient.set(key, JSON.stringify(entry), 'PX', ttlMs);
  } catch (err) {
    console.error('betaSurvey persist comment set failed', err);
  }
}

async function hydratePendingComment(userId) {
  if (!userId) return null;
  cleanupPending();
  const existing = pendingComments.get(userId);
  if (existing) return existing;
  if (!redisClient) return null;
  const key = getCommentRedisKey(userId);
  if (!key) return null;
  try {
    const raw = await redisClient.get(key);
    if (!raw) return null;
    const restored = restorePendingComment(JSON.parse(raw), userId);
    if (!restored) {
      await redisClient.del(key);
      return null;
    }
    pendingComments.set(userId, restored);
    return restored;
  } catch (err) {
    console.error('betaSurvey hydrate comment failed', err);
    return null;
  }
}

async function setPendingComment(userId, entry) {
  if (!userId || !entry) return;
  pendingComments.set(userId, entry);
  await persistPendingComment(userId, entry);
}

async function clearPendingComment(userId) {
  if (!userId) return;
  pendingComments.delete(userId);
  await persistPendingComment(userId, null);
}

function cleanupPending() {
  const now = Date.now();
  for (const [userId, entry] of pendingComments.entries()) {
    if (now - entry.createdAt > COMMENT_TTL_MS) {
      pendingComments.delete(userId);
    }
  }
}

function cleanupQ2Prompts() {
  const now = Date.now();
  for (const [feedbackId, entry] of pendingQ2Prompts.entries()) {
    if (now - entry.createdAt > Q2_PROMPT_TTL_MS) {
      pendingQ2Prompts.delete(feedbackId);
    }
  }
}

function markQ2Prompted(feedbackId) {
  cleanupQ2Prompts();
  if (pendingQ2Prompts.has(feedbackId)) return false;
  pendingQ2Prompts.set(feedbackId, { createdAt: Date.now() });
  return true;
}

function unmarkQ2Prompted(feedbackId) {
  pendingQ2Prompts.delete(feedbackId);
}

function buildQ1Keyboard(caseId) {
  return {
    inline_keyboard: [
      [{ text: msg('beta.survey.q1.option_1'), callback_data: `beta_survey_q1|${caseId}|1` }],
      [{ text: msg('beta.survey.q1.option_2'), callback_data: `beta_survey_q1|${caseId}|2` }],
      [{ text: msg('beta.survey.q1.option_3'), callback_data: `beta_survey_q1|${caseId}|3` }],
      [{ text: msg('beta.survey.q1.option_4'), callback_data: `beta_survey_q1|${caseId}|4` }],
      [{ text: msg('beta.survey.q1.option_5'), callback_data: `beta_survey_q1|${caseId}|5` }],
    ],
  };
}

function buildQ2Keyboard(feedbackId) {
  return {
    inline_keyboard: [
      [{ text: msg('beta.survey.q2.option_1'), callback_data: `beta_survey_q2|${feedbackId}|1` }],
      [{ text: msg('beta.survey.q2.option_2'), callback_data: `beta_survey_q2|${feedbackId}|2` }],
      [{ text: msg('beta.survey.q2.option_3'), callback_data: `beta_survey_q2|${feedbackId}|3` }],
      [{ text: msg('beta.survey.q2.option_4'), callback_data: `beta_survey_q2|${feedbackId}|4` }],
    ],
  };
}

function buildSkipKeyboard(feedbackId) {
  return {
    inline_keyboard: [[{ text: msg('beta.survey.skip_button'), callback_data: `beta_survey_skip|${feedbackId}` }]],
  };
}

async function maybePromptSurvey({ db, ctx, user, caseId }) {
  if (!db || !ctx || !user || !caseId) return false;
  if (user.beta_survey_completed_at) return false;
  if (typeof db.getDiagnosisFeedbackByUser === 'function') {
    const existing = await db.getDiagnosisFeedbackByUser(user.id);
    if (existing) return false;
  }
  await ctx.reply(msg('beta.survey.q1.text'), { reply_markup: buildQ1Keyboard(caseId) });
  return true;
}

async function handleQ1(ctx, db, caseId, score) {
  if (!db || !ctx?.from?.id || !caseId) return false;
  const value = Number(score);
  if (!Number.isFinite(value) || value < 1 || value > 5) return false;
  const user = await db.ensureUser(ctx.from.id);
  if (typeof db.getDiagnosisFeedbackByCase === 'function') {
    const existing = await db.getDiagnosisFeedbackByCase(caseId);
    if (existing) {
      if (existing.q2_clarity_score != null) {
        await ctx.reply(msg('beta.survey.thanks'));
        return true;
      }
      if (existing.q1_confidence_score !== value) {
        await db.updateDiagnosisFeedback(existing.id, user.id, { q1: value });
      }
      if (!markQ2Prompted(existing.id)) {
        return true;
      }
      try {
        await ctx.reply(msg('beta.survey.q2.text'), { reply_markup: buildQ2Keyboard(existing.id) });
      } catch (err) {
        unmarkQ2Prompted(existing.id);
        throw err;
      }
      return true;
    }
  }
  const feedback = await db.createDiagnosisFeedback({
    userId: user.id,
    caseId,
    q1: value,
  });
  if (!feedback?.id) return false;
  if (!markQ2Prompted(feedback.id)) {
    return true;
  }
  try {
    await ctx.reply(msg('beta.survey.q2.text'), { reply_markup: buildQ2Keyboard(feedback.id) });
  } catch (err) {
    unmarkQ2Prompted(feedback.id);
    throw err;
  }
  return true;
}

async function handleQ2(ctx, db, feedbackId, score) {
  if (!db || !ctx?.from?.id || !feedbackId) return false;
  const value = Number(score);
  if (!Number.isFinite(value) || value < 1 || value > 4) return false;
  cleanupQ2Prompts();
  pendingQ2Prompts.delete(feedbackId);
  const user = await db.ensureUser(ctx.from.id);
  const updated = await db.updateDiagnosisFeedback(feedbackId, user.id, { q2: value });
  if (!updated) return false;
  if (typeof db.updateUserBeta === 'function') {
    await db.updateUserBeta(user.id, { betaSurveyCompletedAt: new Date().toISOString() });
  }
  if (typeof db.getBetaEvent === 'function' && typeof db.logBetaEvent === 'function') {
    const existing = await db.getBetaEvent(user.id, 'beta_survey_completed');
    if (!existing) {
      await db.logBetaEvent({
        userId: user.id,
        eventType: 'beta_survey_completed',
        payload: { feedback_id: updated.id },
      });
    }
  }
  cleanupPending();
  await setPendingComment(ctx.from.id, { userId: ctx.from.id, feedbackId: updated.id, createdAt: Date.now() });
  await ctx.reply(msg('beta.survey.q3'), { reply_markup: buildSkipKeyboard(updated.id) });
  return true;
}

async function handleSkip(ctx, db, feedbackId) {
  if (!ctx?.from?.id) return false;
  const userId = ctx.from.id;
  cleanupPending();
  await clearPendingComment(userId);
  await ctx.reply(msg('beta.survey.thanks'));
  return true;
}

async function handleComment(ctx, db) {
  const tgUserId = ctx?.from?.id;
  const text = ctx?.message?.text?.trim();
  if (!tgUserId || !text) return false;
  if (text.startsWith('/')) return false;
  cleanupPending();
  const pending = (await hydratePendingComment(tgUserId)) || null;
  if (!pending) return false;
  if (await isAwaitingRegionAsync(tgUserId)) return false;
  if (shouldBypassPendingComment(ctx, text)) return false;
  if (db?.updateDiagnosisFeedback && db?.ensureUser) {
    const user = await db.ensureUser(tgUserId);
    if (user?.id) {
      await db.updateDiagnosisFeedback(pending.feedbackId, user.id, { q3: text });
    }
  }
  await clearPendingComment(tgUserId);
  await ctx.reply(msg('beta.survey.thanks'));
  return true;
}

async function handleSkipCommand(ctx, db) {
  const userId = ctx?.from?.id;
  if (!userId) return false;
  cleanupPending();
  const pending = (await hydratePendingComment(userId)) || null;
  if (!pending) return false;
  await clearPendingComment(userId);
  await ctx.reply(msg('beta.survey.thanks'));
  return true;
}

function shouldBypassPendingComment(ctx, text) {
  const normalized = String(text || '').trim();
  if (!normalized) return false;
  if (SURVEY_BYPASS_RE.test(normalized)) return true;

  const replyText = String(
    ctx?.message?.reply_to_message?.text ||
      ctx?.message?.reply_to_message?.caption ||
      '',
  ).trim();
  if (!replyText) return false;
  if (!REGION_REPLY_PROMPT_RE.test(replyText)) return false;
  if (!REGION_TEXT_RE.test(normalized)) return false;
  return true;
}

module.exports = {
  configurePersistence,
  maybePromptSurvey,
  handleQ1,
  handleQ2,
  handleSkip,
  handleComment,
  handleSkipCommand,
  __getPendingComments,
};
