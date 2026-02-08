'use strict';

const { msg } = require('./utils');
const { betaFollowupDays, betaRetryDays, isBetaEnabled } = require('./beta');

const DAY_MS = 24 * 60 * 60 * 1000;

function buildActionKeyboard(followupId) {
  return {
    inline_keyboard: [
      [{ text: msg('beta.followup.action.none'), callback_data: `beta_followup_action|${followupId}|none` }],
      [{ text: msg('beta.followup.action.bot_plan'), callback_data: `beta_followup_action|${followupId}|bot_plan` }],
      [{ text: msg('beta.followup.action.own_way'), callback_data: `beta_followup_action|${followupId}|own_way` }],
      [{ text: msg('beta.followup.action.human_expert'), callback_data: `beta_followup_action|${followupId}|human_expert` }],
    ],
  };
}

function buildResultKeyboard(followupId) {
  return {
    inline_keyboard: [
      [
        { text: msg('beta.followup.result.worse'), callback_data: `beta_followup_result|${followupId}|worse` },
        { text: msg('beta.followup.result.same'), callback_data: `beta_followup_result|${followupId}|same` },
        { text: msg('beta.followup.result.better'), callback_data: `beta_followup_result|${followupId}|better` },
      ],
    ],
  };
}

function isBlockedError(err) {
  const code = err?.response?.error_code;
  const description = String(err?.response?.description || err?.description || '');
  if (code === 403) return true;
  return description.toLowerCase().includes('bot was blocked');
}

async function scheduleFollowup(db, userId, caseId) {
  if (!db?.createFollowupFeedback || !userId || !caseId) return null;
  if (!isBetaEnabled()) return null;
  const existing = typeof db.getFollowupByCase === 'function' ? await db.getFollowupByCase(userId, caseId) : null;
  if (existing) return existing;
  const dueAt = new Date(Date.now() + betaFollowupDays() * DAY_MS);
  const retryAt = new Date(dueAt.getTime() + betaRetryDays() * DAY_MS);
  return db.createFollowupFeedback({ userId, caseId, dueAt, retryAt });
}

function createBetaFollowupScheduler({ bot, db, intervalMs }) {
  if (!bot || !db) throw new Error('beta followup scheduler requires bot and db');
  const tickInterval = Number(intervalMs || process.env.BETA_FOLLOWUP_TICK_MS || 3600000);
  let timer = null;
  let running = false;

  async function deliver(followup) {
    if (!followup?.id || !followup?.user_tg_id) return;
    try {
      await bot.telegram.sendMessage(followup.user_tg_id, msg('beta.followup.prompt'), {
        reply_markup: buildActionKeyboard(followup.id),
      });
      const attempts = Number(followup.attempts || 0) + 1;
      await db.updateFollowupFeedback(followup.id, {
        sentAt: new Date().toISOString(),
        attempts,
      });
    } catch (err) {
      console.error('beta followup send error', err);
      if (isBlockedError(err)) {
        await db.updateFollowupFeedback(followup.id, { status: 'blocked' });
      }
    }
  }

  async function tick() {
    try {
      if (!isBetaEnabled()) return;
      const due = await db.listDueFollowups(new Date());
      for (const followup of due) {
        await deliver(followup);
      }
    } catch (err) {
      console.error('beta followup tick error', err);
    }
  }

  async function start() {
    if (running) return;
    running = true;
    await tick();
    timer = setInterval(async () => {
      await tick();
    }, tickInterval);
    if (typeof timer.unref === 'function') timer.unref();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
    running = false;
  }

  async function handleAction(ctx, followupId, choice) {
    if (!ctx?.from?.id || !followupId) return false;
    const user = await db.ensureUser(ctx.from.id);
    const action = String(choice || '');
    const status = action === 'bot_plan' ? 'waiting_result' : 'answered';
    const answeredAt = action === 'bot_plan' ? null : new Date().toISOString();
    const updated = await db.updateFollowupFeedback(
      followupId,
      {
        actionChoice: action,
        status,
        answeredAt,
      },
      user.id,
    );
    if (!updated) return false;
    if (action === 'bot_plan') {
      await ctx.reply(msg('beta.followup.result_question'), { reply_markup: buildResultKeyboard(updated.id) });
      return true;
    }
    if (typeof db.logBetaEvent === 'function' && typeof db.getBetaEvent === 'function') {
      const existing = await db.getBetaEvent(user.id, 'beta_followup_answered');
      if (!existing) {
        await db.logBetaEvent({
          userId: user.id,
          eventType: 'beta_followup_answered',
          payload: { followup_id: updated.id, action_choice: action },
        });
      }
    }
    await ctx.reply(msg('beta.followup.thanks'));
    return true;
  }

  async function handleResult(ctx, followupId, choice) {
    if (!ctx?.from?.id || !followupId) return false;
    const user = await db.ensureUser(ctx.from.id);
    const result = String(choice || '');
    const updated = await db.updateFollowupFeedback(
      followupId,
      {
        resultChoice: result,
        status: 'answered',
        answeredAt: new Date().toISOString(),
      },
      user.id,
    );
    if (!updated) return false;
    if (typeof db.logBetaEvent === 'function' && typeof db.getBetaEvent === 'function') {
      const existing = await db.getBetaEvent(user.id, 'beta_followup_answered');
      if (!existing) {
        await db.logBetaEvent({
          userId: user.id,
          eventType: 'beta_followup_answered',
          payload: {
            followup_id: updated.id,
            action_choice: updated.action_choice || 'bot_plan',
            result_choice: result,
          },
        });
      }
    }
    await ctx.reply(msg('beta.followup.thanks'));
    return true;
  }

  return { start, stop, scheduleFollowup, handleAction, handleResult };
}

module.exports = {
  createBetaFollowupScheduler,
  scheduleFollowup,
};
