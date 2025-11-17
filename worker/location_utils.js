'use strict';

function toNumber(value, fallback = null) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function resolveObjectLocation(meta = {}, fallbackLat = null, fallbackLon = null) {
  const lat = toNumber(meta.lat);
  const lon = toNumber(meta.lon);
  if (lat !== null && lon !== null) {
    return {
      lat,
      lon,
      source: meta.location_source || 'manual',
      warned: Boolean(meta.location_default_warned),
    };
  }
  const envLat = toNumber(fallbackLat, toNumber(process.env.WEATHER_LAT, 55.751244));
  const envLon = toNumber(fallbackLon, toNumber(process.env.WEATHER_LON, 37.618423));
  return {
    lat: envLat,
    lon: envLon,
    source: 'default',
    warned: Boolean(meta.location_default_warned),
  };
}

module.exports = { resolveObjectLocation };
