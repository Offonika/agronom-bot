'use strict';

const BASE_URL = 'https://api.open-meteo.com/v1/forecast';

function buildUrl({ latitude, longitude, hours }) {
  const forecastDays = Math.max(1, Math.ceil(Number(hours || 72) / 24));
  const params = new URLSearchParams({
    latitude: String(latitude),
    longitude: String(longitude),
    hourly: 'temperature_2m,precipitation,wind_speed_10m',
    forecast_days: String(forecastDays),
    timezone: 'UTC',
  });
  return `${BASE_URL}?${params.toString()}`;
}

async function fetchForecast({ latitude, longitude, hours = 72, fetchImpl }) {
  if (latitude == null || longitude == null) {
    throw new Error('weather_missing_coordinates');
  }
  const fetchFn = fetchImpl || fetch;
  const url = buildUrl({ latitude, longitude, hours });
  const response = await fetchFn(url);
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`weather_fetch_failed:${response.status}:${body.slice(0, 100)}`);
  }
  const payload = await response.json();
  const times = payload?.hourly?.time || [];
  const temps = payload?.hourly?.temperature_2m || [];
  const rain = payload?.hourly?.precipitation || [];
  const wind = payload?.hourly?.wind_speed_10m || [];

  const entries = [];
  for (let idx = 0; idx < times.length; idx += 1) {
    const ts = new Date(times[idx]);
    if (Number.isNaN(ts.getTime())) continue;
    entries.push({
      time: ts,
      temperature: Number(temps[idx]),
      precipitation: Number(rain[idx]),
      wind: Number(wind[idx]),
    });
  }
  return entries;
}

function createOpenMeteoProvider(opts = {}) {
  return {
    getHourlyForecast: ({ latitude, longitude, horizonHours }) =>
      fetchForecast({
        latitude,
        longitude,
        hours: horizonHours,
        fetchImpl: opts.fetchImpl,
      }),
  };
}

module.exports = { createOpenMeteoProvider };
