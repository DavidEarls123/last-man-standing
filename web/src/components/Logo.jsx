/**
 * The platform mark. Two drawings behind one component, because the super admin
 * can run the platform under another name for a trial and the horseshoe is Off
 * The Bridle's own.
 *
 * Both are `currentColor` on `hole`, so whatever is around them decides the two
 * colours — floodlight-on-pitch in the bars, white-on-green under a club name.
 */
export default function Logo({ size = 32, hole = 'var(--brand)', variant = 'horseshoe', title, ...rest }) {
  const shared = {
    width: size,
    height: size,
    viewBox: '0 0 64 64',
    role: title ? 'img' : 'presentation',
    'aria-label': title,
    'aria-hidden': title ? undefined : 'true',
    ...rest,
  };

  if (variant === 'ball') {
    return (
      <svg {...shared}>
        <circle cx="32" cy="32" r="25" fill="currentColor" />
        {/* Centre panel and five seams: enough football to read at 20px, and
            little enough not to turn to mud there. */}
        <polygon points="32,17.5 43.8,26.1 39.3,40 24.7,40 20.2,26.1" fill={hole} />
        <path
          d="M32 17.5 V8 M43.8 26.1 L52.8 19.2 M39.3 40 L44.8 51.8 M24.7 40 L19.2 51.8 M20.2 26.1 L11.2 19.2"
          stroke={hole}
          strokeWidth="4.5"
          strokeLinecap="round"
          fill="none"
        />
      </svg>
    );
  }

  return (
    <svg {...shared}>
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
