import { useEffect, useMemo, useRef } from 'react';

/**
 * The round picker used by both the Gameweek and Pick tabs.
 *
 * Ten rounds are on screen at once, wound back four from wherever the
 * competition currently is: rounds 1-4 all show 1-10, round 5 shows 2-11,
 * round 6 shows 3-12, and so on. Every round in the season is still in the
 * strip though, so you can scroll either way to look back or plan ahead.
 */
const VISIBLE = 10;
const LOOKBACK = 4;

export function windowStart(current, lastRound, visible = VISIBLE, lookback = LOOKBACK) {
  const start = Math.max(1, current - lookback);
  // Do not leave dead space at the right hand end of a short season.
  return Math.max(1, Math.min(start, lastRound - visible + 1));
}

/**
 * @param {number}   lastRound  highest round in the season
 * @param {number}   value      the round on screen
 * @param {number}   current    the round the competition itself is up to
 * @param {Function} stateFor   round -> { tone, marker, title, disabled }
 */
export default function RoundStrip({ lastRound, value, current, onChange, stateFor }) {
  const trackRef = useRef(null);
  const anchor = useMemo(
    () => windowStart(current || 1, Math.max(lastRound, VISIBLE)),
    [current, lastRound],
  );

  // Slide the anchor round to the left edge on load, and again if the
  // competition moves on while the tab is open. Clicking a round does not
  // re-scroll — that would yank the strip out from under your thumb.
  useEffect(() => {
    const track = trackRef.current;
    const button = track?.querySelector(`[data-round="${anchor}"]`);
    if (!track || !button) return;
    track.scrollTo({ left: button.offsetLeft - track.offsetLeft, behavior: 'auto' });
  }, [anchor]);

  const rounds = Array.from({ length: lastRound }, (_, index) => index + 1);

  return (
    <div className="roundstrip">
      <div className="roundstrip-track" ref={trackRef} role="tablist" aria-label="Round">
        {rounds.map((round) => {
          const { tone = 'future', marker = '', title, disabled = false } = stateFor(round) || {};
          return (
            <button
              key={round}
              type="button"
              role="tab"
              data-round={round}
              aria-selected={round === value}
              title={title}
              disabled={disabled}
              className={`roundstrip-btn tone-${tone}${round === value ? ' selected' : ''}`}
              onClick={() => onChange(round)}
            >
              <span className="roundstrip-n">{round}</span>
              <span className="roundstrip-mark" aria-hidden="true">{marker}</span>
            </button>
          );
        })}
      </div>
      <div className="roundstrip-key tiny dim">
        <span><i className="key-dot tone-won" />Through</span>
        <span><i className="key-dot tone-lost" />Out</span>
        <span><i className="key-dot tone-now" />This week</span>
        <span><i className="key-dot tone-future" />To come</span>
      </div>
    </div>
  );
}

/**
 * Shared colouring: green for a round you came through, red for the one that
 * knocked you out, orange for where the competition is now, grey ahead.
 */
export function roundToneFor(round, { current, picks = [], lastSettledRound = 0 }) {
  const pick = picks.find((entry) => entry.round === round);
  if (round === current) return { tone: 'now', marker: pick ? '•' : '' };
  if (round < current || round <= lastSettledRound) {
    if (pick?.result === 'survived') return { tone: 'won', marker: '✓' };
    if (pick?.result === 'eliminated') return { tone: 'lost', marker: '✕' };
    return { tone: 'past', marker: '' };
  }
  return { tone: 'future', marker: pick ? '•' : '' };
}
