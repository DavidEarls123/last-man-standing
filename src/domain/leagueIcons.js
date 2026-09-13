/**
 * Ready-made crests, for admins who would rather not find and upload an image.
 *
 * Keys are stored on the league and rendered client-side, so they cost nothing
 * to serve and stay crisp at any size. The server validates against this list,
 * so an unknown key can never be saved.
 */
export const LEAGUE_ICONS = [
  // Football and sport
  { key: 'football', emoji: '⚽', label: 'Football', group: 'Sport' },
  { key: 'trophy', emoji: '🏆', label: 'Trophy', group: 'Sport' },
  { key: 'medal', emoji: '🥇', label: 'Gold medal', group: 'Sport' },
  { key: 'boots', emoji: '👟', label: 'Boots', group: 'Sport' },
  { key: 'goal', emoji: '🥅', label: 'Goal', group: 'Sport' },
  { key: 'stadium', emoji: '🏟️', label: 'Stadium', group: 'Sport' },
  { key: 'whistle', emoji: '📣', label: 'Whistle', group: 'Sport' },
  { key: 'scarf', emoji: '🧣', label: 'Scarf', group: 'Sport' },

  // Animals, for the club-crest look
  { key: 'lion', emoji: '🦁', label: 'Lion', group: 'Animals' },
  { key: 'eagle', emoji: '🦅', label: 'Eagle', group: 'Animals' },
  { key: 'wolf', emoji: '🐺', label: 'Wolf', group: 'Animals' },
  { key: 'bull', emoji: '🐂', label: 'Bull', group: 'Animals' },
  { key: 'ram', emoji: '🐏', label: 'Ram', group: 'Animals' },
  { key: 'fox', emoji: '🦊', label: 'Fox', group: 'Animals' },
  { key: 'owl', emoji: '🦉', label: 'Owl', group: 'Animals' },
  { key: 'dragon', emoji: '🐉', label: 'Dragon', group: 'Animals' },
  { key: 'shark', emoji: '🦈', label: 'Shark', group: 'Animals' },
  { key: 'horse', emoji: '🐎', label: 'Horse', group: 'Animals' },

  // Everything else
  { key: 'crown', emoji: '👑', label: 'Crown', group: 'General' },
  { key: 'star', emoji: '⭐', label: 'Star', group: 'General' },
  { key: 'castle', emoji: '🏰', label: 'Castle', group: 'General' },
  { key: 'anchor', emoji: '⚓', label: 'Anchor', group: 'General' },
  { key: 'rocket', emoji: '🚀', label: 'Rocket', group: 'General' },
  { key: 'lightning', emoji: '⚡', label: 'Lightning', group: 'General' },
  { key: 'fire', emoji: '🔥', label: 'Fire', group: 'General' },
  { key: 'pint', emoji: '🍺', label: 'Pint', group: 'General' },
  { key: 'darts', emoji: '🎯', label: 'Bullseye', group: 'General' },
  { key: 'skull', emoji: '💀', label: 'Skull', group: 'General' },
];

const BY_KEY = new Map(LEAGUE_ICONS.map((icon) => [icon.key, icon]));

export const isLeagueIcon = (key) => BY_KEY.has(key);
export const leagueIcon = (key) => BY_KEY.get(key) ?? null;
