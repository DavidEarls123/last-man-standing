import { api } from '../api.js';

/**
 * The ready-made crests, fetched once from the server so the list cannot drift
 * from the one the server validates against.
 */
let cache = null;

export async function leagueIcons() {
  if (!cache) cache = api.get('/api/leagues/icons').then((result) => result.icons);
  return cache;
}

/** Synchronous lookup for rendering, once the list has been fetched. */
let byKey = new Map();
leagueIcons().then((icons) => { byKey = new Map(icons.map((icon) => [icon.key, icon])); }).catch(() => {});
export const iconEmoji = (key) => byKey.get(key)?.emoji ?? null;
