/**
 * The Last One Standing mark: a football sitting in the mouth of a horseshoe.
 *
 * Drawn geometrically rather than illustrated, so it still reads at 20px in a
 * browser tab. The shoe is a stroke in `currentColor`; the ball is a solid disc
 * with its panel knocked out in `hole`, which should match whatever is behind
 * the mark.
 */
export default function Logo({ size = 32, hole = 'var(--brand)', title, ...rest }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      role={title ? 'img' : 'presentation'}
      aria-label={title}
      aria-hidden={title ? undefined : 'true'}
      {...rest}
    >
      {/* Ends up, the way you are meant to hang one, so the luck stays in it —
          which also makes a cup for the ball to sit in. */}
      <path
        d="M14 13 V34 a18 18 0 0 0 36 0 V13"
        fill="none"
        stroke="currentColor"
        strokeWidth="6.8"
        strokeLinecap="round"
      />
      {/* Nail holes: the detail that makes it a horseshoe and not a magnet. */}
      <circle cx="14" cy="20" r="1.8" fill={hole} />
      <circle cx="50" cy="20" r="1.8" fill={hole} />
      {/* The ball is ringed in the background colour so it reads as a ball
          sitting in the shoe, not a blob welded to it. */}
      <circle cx="32" cy="34" r="12.2" fill={hole} />
      <circle cx="32" cy="34" r="10.7" fill="currentColor" />
      <polygon points="32,26.9 38.8,31.8 36.2,39.7 27.8,39.7 25.2,31.8" fill={hole} />
    </svg>
  );
}
