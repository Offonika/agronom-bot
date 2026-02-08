const { sendConsentScreen } = require('./privacyNotice');

async function requirePrivacyConsent(ctx, db, versions) {
  const userId = ctx.from?.id;
  if (!userId || !db?.ensureUser || !db?.getConsentStatus) return true;
  const privacyVersion = typeof versions === 'string' ? versions : versions?.privacy;
  const offerVersion = typeof versions === 'object' ? versions.offer : null;
  let dbUser = null;
  try {
    dbUser = await db.ensureUser(userId);
  } catch (err) {
    console.error('consentGate ensureUser failed', err);
    return true;
  }
  if (!dbUser) return true;
  const privacyConsent = await db.getConsentStatus(dbUser.id, 'privacy');
  const offerConsent = offerVersion ? await db.getConsentStatus(dbUser.id, 'offer') : null;
  const privacyOk =
    privacyConsent && privacyConsent.status && privacyConsent.doc_version === privacyVersion;
  const offerOk =
    !offerVersion || (offerConsent && offerConsent.status && offerConsent.doc_version === offerVersion);
  if (!privacyOk || !offerOk) {
    await sendConsentScreen(ctx, { acceptCallback: 'consent_accept|all' });
    return false;
  }
  return true;
}

module.exports = { requirePrivacyConsent };
