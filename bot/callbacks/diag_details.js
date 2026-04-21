'use strict';

const { msg } = require('../utils');
const { buildAssistantDetailsText } = require('../messageFormatters/diagnosisMessage');

const MAX_TELEGRAM_MESSAGE = 3500;

function splitTelegramMessage(text, maxLen = MAX_TELEGRAM_MESSAGE) {
  if (!text) return [''];
  const chunks = [];
  const paragraphs = String(text).split(/\n{2,}/);
  let current = '';
  const flush = () => {
    if (!current) return;
    chunks.push(current);
    current = '';
  };
  const tryAppend = (piece, sep) => {
    const candidate = current ? `${current}${sep}${piece}` : piece;
    if (candidate.length <= maxLen) {
      current = candidate;
      return true;
    }
    return false;
  };
  for (const para of paragraphs) {
    if (!para) continue;
    if (tryAppend(para, '\n\n')) continue;
    flush();
    if (para.length <= maxLen) {
      current = para;
      continue;
    }
    for (let idx = 0; idx < para.length; idx += maxLen) {
      chunks.push(para.slice(idx, idx + maxLen));
    }
  }
  flush();
  return chunks.length ? chunks : [''];
}

async function sendChunkedReply(ctx, text) {
  const chunks = splitTelegramMessage(text);
  for (const chunk of chunks) {
    await ctx.reply(chunk);
  }
}

function createDiagDetailsHandler({ db, rememberDiagnosis, safeAnswerCbQuery }) {
  return async function diagDetailsHandler(ctx) {
    if (typeof safeAnswerCbQuery === 'function') {
      await safeAnswerCbQuery(ctx);
    }
    const diagnosisId = Number(ctx.match?.[1]);
    const tgUserId = ctx.from?.id;
    if (!tgUserId || !diagnosisId || typeof db?.getRecentDiagnosisById !== 'function') {
      await ctx.reply(msg('diag_details_not_found'));
      return;
    }
    try {
      const user = await db.ensureUser(tgUserId);
      const record = await db.getRecentDiagnosisById(user.id, diagnosisId);
      const payload = record?.diagnosis_payload;
      if (!payload) {
        await ctx.reply(msg('diag_details_not_found'));
        return;
      }
      payload.recent_diagnosis_id = record.id;
      if (record.object_id && !payload.object_id) {
        payload.object_id = record.object_id;
      }
      if (record.case_id && !payload.case_id) {
        payload.case_id = record.case_id;
      }
      if (typeof rememberDiagnosis === 'function') {
        rememberDiagnosis(tgUserId, payload);
      }
      const detailsText = buildAssistantDetailsText(payload);
      if (!detailsText) {
        await ctx.reply(msg('diag_details_not_found'));
        return;
      }
      const channelLine = msg('diagnosis.channel_follow');
      const fullText = channelLine ? `${detailsText}\n\n${channelLine}` : detailsText;
      await sendChunkedReply(ctx, `${msg('diag_details_title')}\n\n${fullText}`);
    } catch (err) {
      console.error('diag_details failed', err);
      await ctx.reply(msg('diag_details_error'));
    }
  };
}

module.exports = {
  createDiagDetailsHandler,
  splitTelegramMessage,
};
