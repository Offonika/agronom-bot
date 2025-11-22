const MIN_PHOTOS = 3;
const MAX_PHOTOS = 8;
const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes

const sessions = new Map();

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

function startSession(userId) {
  const session = {
    userId,
    photos: [],
    skipOptional: false,
    updatedAt: now(),
  };
  sessions.set(userId, session);
  return session;
}

function clearSession(userId) {
  if (!userId) return false;
  return sessions.delete(userId);
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
  if (!session) return { count: 0, ready: false, photos: [], optionalSkipped: false };
  return {
    count: session.photos.length,
    ready: session.photos.length >= MIN_PHOTOS,
    photos: [...session.photos],
    optionalSkipped: session.skipOptional,
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
  addPhoto,
  getState,
  pickPrimary,
  clearSession,
  skipOptional,
  __getSessions,
};
