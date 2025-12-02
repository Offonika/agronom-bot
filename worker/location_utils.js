'use strict';

function toNumber(value, fallback = null) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function resolveObjectLocation(meta = {}, fallbackLat = null, fallbackLon = null, label = null) {
  const lat = toNumber(meta.lat);
  const lon = toNumber(meta.lon);
  const resolvedLabel = meta.geo_label || label || null;
  const warnedAtRaw = meta.location_default_warned_at ? new Date(meta.location_default_warned_at) : null;
  const warnedAt = warnedAtRaw && !Number.isNaN(warnedAtRaw.getTime()) ? warnedAtRaw : null;
  if (lat !== null && lon !== null) {
    return {
      lat,
      lon,
      source: meta.location_source || 'manual',
      warned: Boolean(meta.location_default_warned),
      warned_at: warnedAt,
      label: resolvedLabel,
    };
  }
  const envLat = toNumber(fallbackLat, toNumber(process.env.WEATHER_LAT, 55.751244));
  const envLon = toNumber(fallbackLon, toNumber(process.env.WEATHER_LON, 37.618423));
  return {
    lat: envLat,
    lon: envLon,
    source: 'default',
    warned: Boolean(meta.location_default_warned),
    warned_at: warnedAt,
    label: resolvedLabel,
  };
}

module.exports = { resolveObjectLocation };
