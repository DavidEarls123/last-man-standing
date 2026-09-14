import { useState } from 'react';
import { Empty } from './ui.jsx';

/**
 * The shape of the field, round by round, without naming anybody.
 *
 * This is what an anonymous league shows in place of the entrants list: one
 * column per round, split into who was still standing after it and who had
 * gone. Both halves are counts of the same thing — people — so they share one
 * axis and stack rather than sitting on two scales.
 *
 * The two colours are picked apart by lightness as well as hue, so the split
 * survives red/green colour blindness; every column also carries its numbers,
 * and the table view underneath is the same data in words.
 */
export default function FieldChart({ rounds, totalEntries, me }) {
  const [hover, setHover] = useState(null);
  const [asTable, setAsTable] = useState(false);

  if (!rounds || rounds.length === 0) {
    return <Empty>Nothing settled yet — the graph fills in as rounds are played.</Empty>;
  }

  const max = Math.max(totalEntries, ...rounds.map((round) => round.startedWith));
  const active = hover ?? rounds[rounds.length - 1];

  return (
    <div className="stack" style={{ gap: 10 }}>
      <div className="fieldchart-legend tiny">
        <span><i className="key-dot chart-in" />Still in</span>
        <span><i className="key-dot chart-out" />Knocked out</span>
        <button type="button" className="btn-ghost btn-sm" onClick={() => setAsTable(!asTable)}>
          {asTable ? 'Show graph' : 'Show table'}
        </button>
      </div>

      {asTable ? (
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>Round</th><th>Started with</th><th>Out</th><th>Still in</th></tr>
            </thead>
            <tbody>
              {rounds.map((round) => (
                <tr key={round.round}>
                  <td>R{round.round}</td>
                  <td>{round.startedWith}</td>
                  <td>{round.eliminated}</td>
                  <td>{round.survivors}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <>
          <div className="fieldchart" onMouseLeave={() => setHover(null)}>
            {rounds.map((round) => {
              const out = totalEntries - round.survivors;
              return (
                <div
                  key={round.round}
                  /* A div, not a button: Chromium sizes a button's content box
                     to fit its contents, which flattens percentage-height bars
                     to hairlines. Nothing here is a command, only a readout. */
                  className={`fieldchart-col${hover?.round === round.round ? ' hot' : ''}`}
                  tabIndex={0}
                  role="img"
                  onMouseEnter={() => setHover(round)}
                  onFocus={() => setHover(round)}
                  onBlur={() => setHover(null)}
                  aria-label={`Round ${round.round}: ${round.survivors} still in, ${out} out`}
                >
                  <span className="fieldchart-plot">
                    <span className="fieldchart-seg out" style={{ height: `${(out / max) * 100}%` }} />
                    <span className="fieldchart-seg in" style={{ height: `${(round.survivors / max) * 100}%` }} />
                    <span className="fieldchart-value">{round.survivors}</span>
                  </span>
                  <span className="fieldchart-x tiny">{round.round}</span>
                </div>
              );
            })}
          </div>
          <p className="tiny dim" style={{ margin: 0 }}>
            {hover ? 'Round' : 'After round'} <strong>{active.round}</strong>:{' '}
            {active.survivors} still in, {totalEntries - active.survivors} out of {totalEntries}.
            {' '}Rounds along the bottom.
          </p>
        </>
      )}

      {me && (
        <div className="fieldchart-you small">
          <span className={`badge ${me.status === 'active' ? 'badge-in' : 'badge-out'}`}>
            {me.isWinner ? 'Winner' : me.status === 'active' ? 'You are in' : 'You are out'}
          </span>
          <span className="muted">
            {me.status === 'active'
              ? `${me.roundsSurvived} round${me.roundsSurvived === 1 ? '' : 's'} survived`
              : `Went out in round ${me.eliminatedRound}`}
          </span>
        </div>
      )}
    </div>
  );
}
