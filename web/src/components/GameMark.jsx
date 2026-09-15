import Logo from './Logo.jsx';

/**
 * A game's own icon. The company mark is a football in a horseshoe; every game
 * keeps the football, drawn the same way, and swaps the horseshoe for something
 * about that game.
 *
 * Last One Standing gets "The One": a numeral one standing on the ball. Stacked
 * rather than side by side, because side by side it reads as a golf pin once it
 * gets small.
 */
function TheOne({ size, hole }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
      <path d="M32 13 V37" fill="none" stroke="currentColor" strokeWidth="9.5" strokeLinecap="round" />
      <path d="M21 21 L31 13" fill="none" stroke="currentColor" strokeWidth="9.5" strokeLinecap="round" />
      {/* Ringed in the background colour so the ball stays a ball, not a foot. */}
      <circle cx="32" cy="47" r="13" fill={hole} />
      <circle cx="32" cy="47" r="11.5" fill="currentColor" />
      <polygon points="32,39.2 39.4,44.6 36.6,53.3 27.4,53.3 24.6,44.6" fill={hole} />
    </svg>
  );
}

const MARKS = { lms: TheOne };

export default function GameMark({ game, size = 24, hole = 'var(--pitch-deep)', ...rest }) {
  const Mark = MARKS[game];
  if (!Mark) return <Logo size={size} hole={hole} {...rest} />;
  return <span className="gamemark" {...rest}><Mark size={size} hole={hole} /></span>;
}
