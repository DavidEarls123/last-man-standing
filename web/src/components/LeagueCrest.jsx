import { iconEmoji } from '../lib/icons.js';
import Logo from './Logo.jsx';

/**
 * A league with no crest of its own wears the house mark, in one of these
 * pairs. Dark plate, light mark, every pair legible at 24px — and picked from
 * the league's own id, so a league keeps the same crest for life rather than
 * changing colour every time the page loads.
 */
const HOUSE_COLOURS = [
  ['#0a3a29', '#ffd24a'],
  ['#1d3a8a', '#fde047'],
  ['#8c1d2b', '#ffd9a8'],
  ['#4c1d95', '#d8b4fe'],
  ['#0f766e', '#7de8d6'],
  ['#9a3412', '#fed7aa'],
  ['#1f2937', '#93c5fd'],
  ['#065f46', '#a7f3d0'],
  ['#86174a', '#fbcfe8'],
  ['#7c4a05', '#fde68a'],
];

/** A stable number from whatever identifies the league. */
function seedFor(league) {
  if (Number.isInteger(league?.id)) return league.id;
  const text = String(league?.name ?? '');
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 31 + text.charCodeAt(index)) % 100_000;
  }
  return hash;
}

export const houseColoursFor = (league) =>
  HOUSE_COLOURS[seedFor(league) % HOUSE_COLOURS.length];

/**
 * Whatever a league is using for a crest: an uploaded image, one of the
 * ready-made icons, or the house mark in the league's own colour pair.
 */
export default function LeagueCrest({ league, className = 'league-crest', size }) {
  const style = size ? { width: size, height: size } : undefined;

  if (league.logoUrl) {
    return <img className={className} style={style} src={league.logoUrl} alt={`${league.name ?? 'League'} crest`} />;
  }

  if (league.logoPreset) {
    return (
      <div className={`${className} placeholder`} style={style} aria-hidden="true">
        {iconEmoji(league.logoPreset) ?? '\u{1F3C6}'}
      </div>
    );
  }

  const [plate, mark] = houseColoursFor(league);
  return (
    <div
      className={`${className} house`}
      style={{ ...style, background: plate, color: mark }}
      aria-hidden="true"
    >
      <Logo size="72%" hole={plate} />
    </div>
  );
}
