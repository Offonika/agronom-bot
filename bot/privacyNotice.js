const { msg } = require('./utils');

const PRIVACY_VERSION = process.env.PRIVACY_VERSION || '1.0';
const OFFER_VERSION = process.env.OFFER_VERSION || '1.0';
const AUTOPAY_VERSION = process.env.AUTOPAY_VERSION || '1.0';

function getPrivacyUrl() {
  return (
    process.env.PRIVACY_URL ||
    'https://agronom.offonika.ru/privacy'
  );
}

function getOfferUrl() {
  return (
    process.env.OFFER_URL ||
    'https://agronom.offonika.ru/offer'
  );
}

function getDocVersion(docType) {
  if (docType === 'privacy') return PRIVACY_VERSION;
  if (docType === 'offer') return OFFER_VERSION;
  if (docType === 'autopay') return AUTOPAY_VERSION;
  return process.env.MARKETING_VERSION || '1.0';
}

function buildConsentKeyboard(docType, opts = {}) {
  const rows = [];
  const privacyUrl = getPrivacyUrl();
  const offerUrl = getOfferUrl();
  if (docType === 'privacy' && privacyUrl) {
    rows.push([{ text: msg('privacy_button'), url: privacyUrl }]);
  }
  if ((docType === 'offer' || docType === 'autopay' || opts.includeOfferLink) && offerUrl) {
    rows.push([{ text: msg('offer_button'), url: offerUrl }]);
  }
  const acceptText = opts.acceptText || msg('consent_accept_button') || 'Согласен';
  const callback = opts.acceptCallback || `consent_accept|${docType}`;
  rows.push([{ text: acceptText, callback_data: callback }]);
  return rows.length ? { inline_keyboard: rows } : null;
}

function buildCombinedConsentKeyboard(opts = {}) {
  const rows = [];
  const privacyUrl = getPrivacyUrl();
  const offerUrl = getOfferUrl();
  if (privacyUrl) {
    rows.push([{ text: msg('consent_privacy_button') || '📄 Политика ПДн', url: privacyUrl }]);
  }
  if (offerUrl) {
    rows.push([{ text: msg('consent_offer_button') || '📄 Оферта', url: offerUrl }]);
  }
  rows.push([
    {
      text: msg('consent_accept_all_button') || '✅ Принимаю и продолжаю',
      callback_data: opts.acceptCallback || 'consent_accept|all',
    },
  ]);
  return rows.length ? { inline_keyboard: rows } : null;
}

async function sendConsentScreen(ctx, opts = {}) {
  const text = msg('consent_screen_text');
  if (!text || !ctx?.reply) return false;
  const keyboard = buildCombinedConsentKeyboard(opts);
  await ctx.reply(text, keyboard ? { reply_markup: keyboard } : undefined);
  return true;
}

async function sendStartNotice(ctx, opts = {}) {
  return sendConsentScreen(ctx, opts);
}

async function sendPhotoNotice(ctx, opts = {}) {
  return sendConsentScreen(ctx, opts);
}

async function sendOfferNotice(ctx, opts = {}) {
  return sendConsentScreen(ctx, opts);
}

module.exports = {
  sendStartNotice,
  sendPhotoNotice,
  sendOfferNotice,
  sendConsentScreen,
  getDocVersion,
  buildConsentKeyboard,
};
