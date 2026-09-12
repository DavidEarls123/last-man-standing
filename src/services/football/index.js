import { config } from '../../config.js';
import { createLocalProvider } from './local.js';
import { createFootballDataProvider } from './footballData.js';

let provider = null;

export function footballProvider() {
  if (provider) return provider;
  if (config.football.provider === 'football-data') {
    provider = createFootballDataProvider({
      apiKey: config.football.apiKey,
      competition: config.football.competition,
    });
  } else {
    provider = createLocalProvider({ simulate: config.football.simulate });
  }
  return provider;
}

export { createLocalProvider, createFootballDataProvider };
