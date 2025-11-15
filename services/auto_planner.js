'use strict';

const { HOURS } = require('./plan_events');

const DEFAULT_RULES = {
  no_rain_hours_before: 2,
  no_rain_hours_after: 6,
  wind_max_m_s: 6,
  wind_min_m_s: 0,
  temp_min_c: 8,
  temp_max_c: 28,
  daylight_only: false,
  duration_min: 90,
  buffer_min: 30,
  rain_threshold_mm: 0.2,
};

function createAutoPlanner({ weatherService, timezone } = {}) {
  if (!weatherService || typeof weatherService.getHourlyForecast !== 'function') {
    throw new Error('auto_planner requires weatherService#getHourlyForecast');
  }
  const tz = timezone || process.env.AUTOPLAN_TIMEZONE || 'Europe/Moscow';

  async function findWindow({
    latitude,
    longitude,
    minHoursAhead = 2,
    horizonHours = 72,
    rules = {},
    now = new Date(),
  }) {
    const mergedRules = { ...DEFAULT_RULES, ...(rules || {}) };
    const forecast = await weatherService.getHourlyForecast({
      latitude,
      longitude,
      horizonHours,
    });
    if (!forecast.length) return null;
    return pickSlot({
      forecast,
      minHoursAhead,
      horizonHours,
      rules: mergedRules,
      now,
      timezone: tz,
    });
  }

  return { findWindow };
}

function pickSlot({ forecast, minHoursAhead, horizonHours, rules, now, timezone }) {
  const startBoundary = new Date(now.getTime() + minHoursAhead * HOURS);
  const endBoundary = new Date(now.getTime() + horizonHours * HOURS);
  let bestSlot = null;

  for (const entry of forecast) {
    const startTime = entry.time;
    if (startTime < startBoundary) continue;
    if (startTime > endBoundary) break;
    const candidate = evaluateWindow({
      forecast,
      startTime,
      rules,
      timezone,
    });
    if (!candidate) continue;
    if (!bestSlot || candidate.score > bestSlot.score) {
      bestSlot = candidate;
    }
  }
  return bestSlot;
}

function evaluateWindow({ forecast, startTime, rules, timezone }) {
  const durationMs = Math.max(Number(rules.duration_min || 0), 30) * 60 * 1000;
  const endTime = new Date(startTime.getTime() + durationMs);
  const beforeStart = new Date(startTime.getTime() - (rules.no_rain_hours_before || 0) * HOURS);
  const afterEnd = new Date(endTime.getTime() + (rules.no_rain_hours_after || 0) * HOURS);
  const windowEntries = filterEntries(forecast, startTime, endTime);
  if (!windowEntries.length) return null;

  const rainThreshold = Number(rules.rain_threshold_mm || 0.2);
  if (hasRain(windowEntries, rainThreshold)) return null;
  if (hasRain(filterEntries(forecast, beforeStart, startTime), rainThreshold)) return null;
  if (hasRain(filterEntries(forecast, endTime, afterEnd), rainThreshold)) return null;

  if (!withinRange(windowEntries, (value) => value.temperature, rules.temp_min_c, rules.temp_max_c)) {
    return null;
  }
  if (!withinRange(windowEntries, (value) => value.wind, rules.wind_min_m_s, rules.wind_max_m_s)) {
    return null;
  }
  if (rules.daylight_only && !isDaylight(startTime, timezone)) {
    return null;
  }

  const score = computeScore({
    startTime,
    now: new Date(),
    wind: avg(windowEntries, (v) => v.wind),
    temperature: avg(windowEntries, (v) => v.temperature),
  });
  const reason = buildReason({
    entries: windowEntries,
    rainThreshold,
    rules,
    timezone,
  });

  return {
    start: startTime,
    end: endTime,
    score,
    reason,
  };
}

function filterEntries(forecast, from, to) {
  if (!forecast?.length) return [];
  return forecast.filter((entry) => entry.time >= from && entry.time < to);
}

function hasRain(entries, threshold) {
  return entries.some((entry) => Number(entry.precipitation || 0) > threshold);
}

function withinRange(entries, accessor, min, max) {
  const lower = Number.isFinite(min) ? Number(min) : null;
  const upper = Number.isFinite(max) ? Number(max) : null;
  return entries.every((entry) => {
    const value = accessor(entry);
    if (lower != null && value < lower) return false;
    if (upper != null && value > upper) return false;
    return true;
  });
}

function avg(entries, accessor) {
  if (!entries.length) return 0;
  const total = entries.reduce((sum, entry) => sum + Number(accessor(entry) || 0), 0);
  return total / entries.length;
}

function computeScore({ startTime, now, wind, temperature }) {
  const hoursDiff = (startTime - now) / HOURS;
  const timingScore = Math.max(0, 120 - hoursDiff * 5);
  const windScore = Math.max(0, 50 - Math.abs((wind || 0) - 3) * 5);
  const tempScore = Math.max(0, 50 - Math.abs((temperature || 0) - 18) * 3);
  return timingScore + windScore + tempScore;
}

function buildReason({ entries, rainThreshold, rules, timezone }) {
  const minTemp = Math.min(...entries.map((entry) => Number(entry.temperature || 0)));
  const maxTemp = Math.max(...entries.map((entry) => Number(entry.temperature || 0)));
  const maxWind = Math.max(...entries.map((entry) => Number(entry.wind || 0)));
  const rainText = `без осадков (${rainThreshold} мм порог)`;
  const tempText = `температура ${minTemp.toFixed(0)}–${maxTemp.toFixed(0)} °C`;
  const windText = `ветер ${maxWind.toFixed(1)} м/с`;
  const timeText = `окно ${formatLocalTime(entries[0].time, timezone)}–${formatLocalTime(
    entries[entries.length - 1].time,
    timezone,
  )}`;
  const reason = [timeText, rainText, tempText, windText];
  if (rules.daylight_only) {
    reason.push('дневное время');
  }
  return reason;
}

function formatLocalTime(date, timezone) {
  return new Intl.DateTimeFormat('ru-RU', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: timezone,
  }).format(date);
}

function isDaylight(date, timezone) {
  const hour = Number(
    new Intl.DateTimeFormat('ru-RU', {
      hour: 'numeric',
      hour12: false,
      timeZone: timezone,
    }).format(date),
  );
  return hour >= 8 && hour <= 21;
}

module.exports = { createAutoPlanner, pickSlot, evaluateWindow };
