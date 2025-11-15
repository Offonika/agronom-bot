'use strict';

const { createOpenMeteoProvider } = require('./openmeteo');

function createWeatherService(options = {}) {
  const providerName = (options.provider || process.env.WEATHER_PROVIDER || 'openmeteo').toLowerCase();
  switch (providerName) {
    case 'openmeteo':
    default:
      return createOpenMeteoProvider(options);
  }
}

module.exports = { createWeatherService };
