const MIN_PHOTOS = 3;
const MAX_PHOTOS = 8;
const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes
const SESSION_TTL_SEC = Math.ceil(SESSION_TTL_MS / 1000);
const SAME_PLANT_CHECK_DAYS = Number(process.env.SAME_PLANT_CHECK_DAYS) || 10;
const rawFollowupMin = Number(process.env.FOLLOWUP_MIN_PHOTOS || '1');
const FOLLOWUP_MIN_PHOTOS =
  Number.isFinite(rawFollowupMin) && rawFollowupMin >= 1
    ? Math.min(rawFollowupMin, MAX_PHOTOS)
    : 1;
const REDIS_KEY_PREFIX = process.env.PHOTO_SESSION_REDIS_PREFIX || 'bot:photo_session:';

const sessions = new Map();
let redisClient = null;
let redisKeyPrefix = REDIS_KEY_PREFIX;

// Store pending "same plant" confirmations
const samePlantPending = new Map();

function __getSessions() {
  return sessions;
}

function now() {
  return Date.now();
}

function configurePersistence(options = {}) {
  redisClient = options.redis || null;
  redisKeyPrefix =
    typeof options.keyPrefix === 'string' && options.keyPrefix.trim()
      ? options.keyPrefix.trim()
      : REDIS_KEY_PREFIX;
}

function getRedisKey(userId) {
  if (!userId) return null;
  return `${redisKeyPrefix}${userId}`;
}

function isExpired(session) {
  if (!session) return true;
  return now() - session.updatedAt > SESSION_TTL_MS;
}

function sanitizePhoto(item) {
  if (!item?.file_id) return null;
  return {
    file_id: String(item.file_id),
    file_unique_id: item.file_unique_id ? String(item.file_unique_id) : null,
    file_size: Number(item.file_size || 0) || 0,
    width: Number(item.width || 0) || 0,
    height: Number(item.height || 0) || 0,
    media_group_id: item.media_group_id ? String(item.media_group_id) : null,
  };
}

function normalizeNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function restoreSession(raw, userId = null) {
  if (!raw || typeof raw !== 'object') return null;
  const photos = Array.isArray(raw.photos) ? raw.photos.map(sanitizePhoto).filter(Boolean) : [];
  const session = {
    userId: raw.userId || userId || null,
    photos,
    skipOptional: Boolean(raw.skipOptional),
    updatedAt: Number(raw.updatedAt) || now(),
    linkedCaseId: normalizeNumber(raw.linkedCaseId),
    linkedObjectId: normalizeNumber(raw.linkedObjectId),
    sourceDiagnosisId: normalizeNumber(raw.sourceDiagnosisId),
    followupMode: Boolean(raw.followupMode),
    followupReason: raw.followupReason || null,
    minPhotos: normalizeNumber(raw.minPhotos),
    samePlantConfirmed: Boolean(raw.samePlantConfirmed),
    samePlantChecked: Boolean(raw.samePlantChecked),
  };
  return isExpired(session) ? null : session;
}

async function persistSession(userId, session) {
  if (!redisClient || !userId) return;
  const key = getRedisKey(userId);
  if (!key) return;
  if (!session || isExpired(session)) {
    try {
      await redisClient.del(key);
    } catch (err) {
      console.error('photoCollector persist delete failed', err);
    }
    return;
  }
  const ttlMs = Math.max(1000, SESSION_TTL_MS - Math.max(0, now() - session.updatedAt));
  try {
    await redisClient.set(key, JSON.stringify(session), 'PX', ttlMs);
  } catch (err) {
    console.error('photoCollector persist set failed', err);
  }
}

async function hydrateSession(userId) {
  const existing = getSession(userId);
  if (existing || !redisClient || !userId) return existing;
  const key = getRedisKey(userId);
  if (!key) return null;
  try {
    const raw = await redisClient.get(key);
    if (!raw) return null;
    const restored = restoreSession(JSON.parse(raw), userId);
    if (!restored) {
      await redisClient.del(key);
      return null;
    }
    sessions.set(userId, restored);
    return restored;
  } catch (err) {
    console.error('photoCollector hydrate failed', err);
    return null;
  }
}

function getMinPhotosForSession(session) {
  if (Number.isFinite(Number(session?.minPhotos)) && Number(session.minPhotos) > 0) {
    return Math.min(Math.max(Math.round(Number(session.minPhotos)), 1), MAX_PHOTOS);
  }
  if (session?.followupMode) {
    return FOLLOWUP_MIN_PHOTOS;
  }
  return MIN_PHOTOS;
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
  const requestedMin = Number(options.minPhotos);
  const minPhotos = Number.isFinite(requestedMin) && requestedMin > 0
    ? Math.min(Math.max(Math.round(requestedMin), 1), MAX_PHOTOS)
    : null;
  const session = {
    userId,
    photos: [],
    skipOptional: false,
    updatedAt: now(),
    // Marketing: Link to existing case if "same plant" confirmed
    linkedCaseId: options.linkedCaseId || null,
    linkedObjectId: options.linkedObjectId || null,
    sourceDiagnosisId: options.sourceDiagnosisId || null,
    followupMode: Boolean(options.followupMode),
    followupReason: options.followupReason || null,
    minPhotos,
    samePlantConfirmed: options.samePlantConfirmed || false,
    samePlantChecked: options.samePlantChecked || false,
  };
  sessions.set(userId, session);
  return session;
}

function startFollowupSession(userId, options = {}) {
  return startSession(userId, {
    linkedCaseId: options.linkedCaseId || null,
    linkedObjectId: options.linkedObjectId || null,
    sourceDiagnosisId: options.sourceDiagnosisId || null,
    minPhotos: options.minPhotos || null,
    followupReason: options.followupReason || null,
    followupMode: true,
    samePlantConfirmed: true,
    samePlantChecked: true,
  });
}

async function startFollowupSessionAsync(userId, options = {}) {
  const session = startFollowupSession(userId, options);
  await persistSession(userId, session);
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

function confirmSamePlant(userId, caseId, objectId = null) {
  const session = getSession(userId) || startSession(userId);
  session.linkedCaseId = caseId;
  session.linkedObjectId = objectId || session.linkedObjectId || null;
  session.samePlantConfirmed = true;
  session.samePlantChecked = true;
  session.followupMode = false;
  session.followupReason = null;
  session.minPhotos = null;
  session.updatedAt = now();
  clearSamePlantPending(userId);
  return session;
}

async function confirmSamePlantAsync(userId, caseId, objectId = null) {
  await hydrateSession(userId);
  const session = confirmSamePlant(userId, caseId, objectId);
  await persistSession(userId, session);
  return session;
}

function denySamePlant(userId) {
  const session = getSession(userId) || startSession(userId);
  session.linkedCaseId = null;
  session.linkedObjectId = null;
  session.samePlantConfirmed = false;
  session.samePlantChecked = true;
  session.followupMode = false;
  session.followupReason = null;
  session.minPhotos = null;
  session.updatedAt = now();
  clearSamePlantPending(userId);
  return session;
}

async function denySamePlantAsync(userId) {
  await hydrateSession(userId);
  const session = denySamePlant(userId);
  await persistSession(userId, session);
  return session;
}

function clearSession(userId) {
  if (!userId) return false;
  const cleared = sessions.delete(userId);
  clearSamePlantPending(userId);
  return cleared;
}

async function clearSessionAsync(userId) {
  const cleared = clearSession(userId);
  await persistSession(userId, null);
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
  const minPhotos = getMinPhotosForSession(existing);
  existing.updatedAt = now();
  if (existing.photos.length >= MAX_PHOTOS) {
    return {
      count: existing.photos.length,
      ready: existing.photos.length >= minPhotos,
      overflow: true,
      photos: [...existing.photos],
      optionalSkipped: existing.skipOptional,
      minPhotos,
      followupMode: existing.followupMode,
    };
  }
  existing.photos.push({
    ...best,
    media_group_id: mediaGroupId || null,
  });
  return {
    count: existing.photos.length,
    ready: existing.photos.length >= minPhotos,
    overflow: false,
    photos: [...existing.photos],
    optionalSkipped: existing.skipOptional,
    minPhotos,
    followupMode: existing.followupMode,
  };
}

async function addPhotoAsync(userId, message) {
  await hydrateSession(userId);
  const result = addPhoto(userId, message);
  await persistSession(userId, getSession(userId));
  return result;
}

function skipOptional(userId) {
  if (!userId) return false;
  const session = getSession(userId) || startSession(userId);
  session.skipOptional = true;
  session.updatedAt = now();
  return true;
}

async function skipOptionalAsync(userId) {
  await hydrateSession(userId);
  const changed = skipOptional(userId);
  await persistSession(userId, getSession(userId));
  return changed;
}

function getState(userId) {
  const session = getSession(userId);
  if (!session) return {
    count: 0,
    ready: false,
    photos: [],
    optionalSkipped: false,
    linkedCaseId: null,
    linkedObjectId: null,
    sourceDiagnosisId: null,
    followupMode: false,
    minPhotos: MIN_PHOTOS,
    samePlantConfirmed: false,
    samePlantChecked: false,
  };
  const minPhotos = getMinPhotosForSession(session);
  return {
    count: session.photos.length,
    ready: session.photos.length >= minPhotos,
    photos: [...session.photos],
    optionalSkipped: session.skipOptional,
    linkedCaseId: session.linkedCaseId || null,
    linkedObjectId: session.linkedObjectId || null,
    sourceDiagnosisId: session.sourceDiagnosisId || null,
    followupMode: Boolean(session.followupMode),
    followupReason: session.followupReason || null,
    minPhotos,
    samePlantConfirmed: session.samePlantConfirmed || false,
    samePlantChecked: session.samePlantChecked || false,
  };
}

async function getStateAsync(userId) {
  await hydrateSession(userId);
  return getState(userId);
}

function pickPrimary(userId) {
  const session = getSession(userId);
  if (!session || !session.photos.length) return null;
  if (session.followupMode) {
    // In follow-up mode user usually sends a targeted clarification frame.
    return session.photos[session.photos.length - 1];
  }
  if (session.photos.length >= 3) {
    // Main diagnosis should prefer the mandatory leaf frame from the base checklist.
    return session.photos[1] || session.photos[2] || session.photos[0];
  }
  return session.photos[session.photos.length - 1];
}

module.exports = {
  MIN_PHOTOS,
  MAX_PHOTOS,
  SAME_PLANT_CHECK_DAYS,
  FOLLOWUP_MIN_PHOTOS,
  configurePersistence,
  addPhoto,
  addPhotoAsync,
  getState,
  getStateAsync,
  pickPrimary,
  clearSession,
  clearSessionAsync,
  skipOptional,
  skipOptionalAsync,
  startFollowupSession,
  startFollowupSessionAsync,
  // Marketing: "Same plant?" flow
  setSamePlantPending,
  getSamePlantPending,
  clearSamePlantPending,
  confirmSamePlant,
  confirmSamePlantAsync,
  denySamePlant,
  denySamePlantAsync,
  __getSessions,
};
