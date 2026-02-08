'use strict';

const { msg } = require('./utils');

const pendingComments = new Map();
const COMMENT_TTL_MS = 24 * 60 * 60 * 1000;
const pendingQ2Prompts = new Map();
const Q2_PROMPT_TTL_MS = 2 * 60 * 1000;

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
  pendingComments.set(ctx.from.id, { feedbackId: updated.id, createdAt: Date.now() });
  await ctx.reply(msg('beta.survey.q3'), { reply_markup: buildSkipKeyboard(updated.id) });
  return true;
}

async function handleSkip(ctx, db, feedbackId) {
  if (!ctx?.from?.id) return false;
  const userId = ctx.from.id;
  cleanupPending();
  if (pendingComments.has(userId)) {
    pendingComments.delete(userId);
  }
  await ctx.reply(msg('beta.survey.thanks'));
  return true;
}

async function handleComment(ctx, db) {
  const tgUserId = ctx?.from?.id;
  const text = ctx?.message?.text?.trim();
  if (!tgUserId || !text) return false;
  if (text.startsWith('/')) return false;
  cleanupPending();
  const pending = pendingComments.get(tgUserId);
  if (!pending) return false;
  if (db?.updateDiagnosisFeedback && db?.ensureUser) {
    const user = await db.ensureUser(tgUserId);
    if (user?.id) {
      await db.updateDiagnosisFeedback(pending.feedbackId, user.id, { q3: text });
    }
  }
  pendingComments.delete(tgUserId);
  await ctx.reply(msg('beta.survey.thanks'));
  return true;
}

async function handleSkipCommand(ctx, db) {
  const userId = ctx?.from?.id;
  if (!userId) return false;
  cleanupPending();
  const pending = pendingComments.get(userId);
  if (!pending) return false;
  pendingComments.delete(userId);
  await ctx.reply(msg('beta.survey.thanks'));
  return true;
}

module.exports = {
  maybePromptSurvey,
  handleQ1,
  handleQ2,
  handleSkip,
  handleComment,
  handleSkipCommand,
};
