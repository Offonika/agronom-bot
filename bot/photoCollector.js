const MIN_PHOTOS = 3;
const MAX_PHOTOS = 8;
const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes
const SAME_PLANT_CHECK_DAYS = Number(process.env.SAME_PLANT_CHECK_DAYS) || 10;

const sessions = new Map();

// Store pending "same plant" confirmations
const samePlantPending = new Map();

function __getSessions() {
  return sessions;
}

function now() {
  return Date.now();
}

function isExpired(session) {
  if (!session) return true;
  return now() - session.updatedAt > SESSION_TTL_MS;
}

function getSession(userId) {
  if (!userId) return null;
  const session = sessions.get(userId);
  if (isExpired(session)) {
    sessions.delete(userId);
    return null;
  }
  return session;
}

function startSession(userId, options = {}) {
  const session = {
    userId,
    photos: [],
    skipOptional: false,
    updatedAt: now(),
    // Marketing: Link to existing case if "same plant" confirmed
    linkedCaseId: options.linkedCaseId || null,
    samePlantConfirmed: options.samePlantConfirmed || false,
    samePlantChecked: options.samePlantChecked || false,
  };
  sessions.set(userId, session);
  return session;
}

// Marketing: Store pending "same plant?" question
function setSamePlantPending(userId, caseData) {
  if (!userId) return;
  samePlantPending.set(userId, {
    ...caseData,
    askedAt: now(),
  });
}

function getSamePlantPending(userId) {
  if (!userId) return null;
  const pending = samePlantPending.get(userId);
  // Expire after 5 minutes
  if (pending && now() - pending.askedAt > 5 * 60 * 1000) {
    samePlantPending.delete(userId);
    return null;
  }
  return pending;
}

function clearSamePlantPending(userId) {
  if (!userId) return false;
  return samePlantPending.delete(userId);
}

function confirmSamePlant(userId, caseId) {
  const session = getSession(userId) || startSession(userId);
  session.linkedCaseId = caseId;
  session.samePlantConfirmed = true;
  session.samePlantChecked = true;
  session.updatedAt = now();
  clearSamePlantPending(userId);
  return session;
}

function denySamePlant(userId) {
  const session = getSession(userId) || startSession(userId);
  session.linkedCaseId = null;
  session.samePlantConfirmed = false;
  session.samePlantChecked = true;
  session.updatedAt = now();
  clearSamePlantPending(userId);
  return session;
}

function clearSession(userId) {
  if (!userId) return false;
  const cleared = sessions.delete(userId);
  clearSamePlantPending(userId);
  return cleared;
}

function addPhoto(userId, message) {
  if (!userId || !message?.photo) {
    return { count: 0, ready: false, overflow: false, photos: [], optionalSkipped: false };
  }
  const { photo, media_group_id: mediaGroupId } = message;
  const ctxPhotos = Array.isArray(photo) ? photo : [];
  const best = ctxPhotos[ctxPhotos.length - 1];
  if (!best) return { count: 0, ready: false, overflow: false, photos: [], optionalSkipped: false };

  const existing = getSession(userId) || startSession(userId);
  existing.updatedAt = now();
  if (existing.photos.length >= MAX_PHOTOS) {
    return {
      count: existing.photos.length,
      ready: existing.photos.length >= MIN_PHOTOS,
      overflow: true,
      photos: [...existing.photos],
      optionalSkipped: existing.skipOptional,
    };
  }
  existing.photos.push({
    ...best,
    media_group_id: mediaGroupId || null,
  });
  return {
    count: existing.photos.length,
    ready: existing.photos.length >= MIN_PHOTOS,
    overflow: false,
    photos: [...existing.photos],
    optionalSkipped: existing.skipOptional,
  };
}

function skipOptional(userId) {
  if (!userId) return false;
  const session = getSession(userId) || startSession(userId);
  session.skipOptional = true;
  session.updatedAt = now();
  return true;
}

function getState(userId) {
  const session = getSession(userId);
  if (!session) return {
    count: 0,
    ready: false,
    photos: [],
    optionalSkipped: false,
    linkedCaseId: null,
    samePlantConfirmed: false,
    samePlantChecked: false,
  };
  return {
    count: session.photos.length,
    ready: session.photos.length >= MIN_PHOTOS,
    photos: [...session.photos],
    optionalSkipped: session.skipOptional,
    linkedCaseId: session.linkedCaseId || null,
    samePlantConfirmed: session.samePlantConfirmed || false,
    samePlantChecked: session.samePlantChecked || false,
  };
}

function pickPrimary(userId) {
  const session = getSession(userId);
  if (!session || !session.photos.length) return null;
  return session.photos[session.photos.length - 1];
}

module.exports = {
  MIN_PHOTOS,
  MAX_PHOTOS,
  SAME_PLANT_CHECK_DAYS,
  addPhoto,
  getState,
  pickPrimary,
  clearSession,
  skipOptional,
  // Marketing: "Same plant?" flow
  setSamePlantPending,
  getSamePlantPending,
  clearSamePlantPending,
  confirmSamePlant,
  denySamePlant,
  __getSessions,
};
