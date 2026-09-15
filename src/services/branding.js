import { getSetting, setSetting, audit } from '../db/index.js';

/**
 * Who the platform says it is.
 *
 * Normally Off The Bridle Sports with its horseshoe. The super admin can point
 * it at somebody else for a trial — a club running the game for its own members
 * — and put it back afterwards. Nothing about a league, an entry or a result
 * depends on this: it is the name and the mark on the furniture, and only that.
 */
export const BRANDING_DEFAULTS = Object.freeze({
  company: 'Off The Bridle Sports',
  mark: 'horseshoe',
});

export const MARKS = Object.freeze([
  Object.freeze({ key: 'horseshoe', label: 'Football in a horseshoe', note: 'The Off The Bridle mark' }),
  Object.freeze({ key: 'ball', label: 'Plain football', note: 'Green and white, no horseshoe' }),
]);

export const isMark = (key) => MARKS.some((mark) => mark.key === key);

export function platformBranding() {
  const stored = getSetting('branding', {}) || {};
  const mark = isMark(stored.mark) ? stored.mark : BRANDING_DEFAULTS.mark;
  const company = String(stored.company || '').trim() || BRANDING_DEFAULTS.company;
  return {
    company,
    mark,
    // So the admin screen can say plainly whether it is showing the real thing.
    isDefault: company === BRANDING_DEFAULTS.company && mark === BRANDING_DEFAULTS.mark,
  };
}

export function setPlatformBranding({ company, mark }, actorUserId = null) {
  const next = {
    company: String(company ?? '').trim() || BRANDING_DEFAULTS.company,
    mark: isMark(mark) ? mark : BRANDING_DEFAULTS.mark,
  };
  setSetting('branding', next);
  audit(actorUserId, 'platform.branding_set', 'platform', null, next);
  return platformBranding();
}

/** Put the real name and mark back. */
export function resetPlatformBranding(actorUserId = null) {
  setSetting('branding', {});
  audit(actorUserId, 'platform.branding_reset', 'platform', null, null);
  return platformBranding();
}
