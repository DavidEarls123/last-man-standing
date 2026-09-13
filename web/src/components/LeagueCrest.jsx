import { iconEmoji } from '../lib/icons.js';

/**
 * Whatever a league is using for a crest: an uploaded image, one of the
 * ready-made icons, or the default trophy.
 */
export default function LeagueCrest({ league, className = 'league-crest', size }) {
  const style = size ? { width: size, height: size } : undefined;
  if (league.logoUrl) {
    return <img className={className} style={style} src={league.logoUrl} alt={`${league.name ?? 'League'} crest`} />;
  }
  const emoji = league.logoPreset ? iconEmoji(league.logoPreset) : null;
  return (
    <div className={`${className} placeholder`} style={style} aria-hidden="true">
      {emoji ?? '\u{1F3C6}'}
    </div>
  );
}
