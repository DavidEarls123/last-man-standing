import { Link } from 'react-router-dom';
import { useLeague } from '../league.jsx';
import { Alert, Bar, Card, Countdown, Empty, Stat } from '../components/ui.jsx';
import LeagueHeader from '../components/LeagueHeader.jsx';
import { ELIMINATION_LABEL, OUTCOME_LABEL, formatDateTime } from '../lib/format.js';

const outcomeClass = (result) => (result === 'survived' ? 'win' : result === 'eliminated' ? 'lost' : '');

export default function LeagueHomePage() {
  const league = useLeague();
  const { overview, picks, standings, needsPick, nextRound, nextDeadline } = league;
  const entry = league.league.entry;
  const isPlayer = Boolean(entry);
  const isOut = entry?.status === 'eliminated';

  return (
    <div className="stack">
      <LeagueHeader league={league.league}>
        {entry?.isWinner
          ? <span className="badge badge-gold">🏆 Winner</span>
          : isPlayer && (
            <span className={`badge ${isOut ? 'badge-out' : 'badge-in'}`}>{isOut ? 'Out' : 'Still in'}</span>
          )}
      </LeagueHeader>

      {isOut && (
        <Alert tone="warn">
          You went out in round {entry.eliminatedRound}
          {entry.eliminatedReason ? ` — ${ELIMINATION_LABEL[entry.eliminatedReason] ?? entry.eliminatedReason}` : ''}.
          You can still follow the league to the end.
        </Alert>
      )}

      {league.reselection?.map((item) => (
        <Alert tone="warn" key={item.round}>
          <strong>{item.team}</strong>'s round {item.round} game is off, so that pick no longer counts —
          and {item.team} goes back in your pool.{' '}
          {item.deadline
            ? <>Pick again within <Countdown deadline={item.deadline} />.{' '}
                <Link to={`/leagues/${league.league.id}/pick`}>Choose a replacement</Link></>
            : 'There is nothing left to switch to, so you go through to the next round.'}
        </Alert>
      ))}

      {isPlayer && !isOut && league.owedOpeningRounds?.length > 0 && (
        <Alert tone="warn">
          This league opens with {league.league.openingPicks} picks. You still owe{' '}
          round{league.owedOpeningRounds.length === 1 ? '' : 's'} {league.owedOpeningRounds.join(', ')},
          due before the first kick off — <Countdown deadline={league.league.entryDeadline} /> left.{' '}
          <Link to={`/leagues/${league.league.id}/pick`}>Make your picks</Link>
        </Alert>
      )}

      {needsPick && !league.owedOpeningRounds?.length && (
        <Alert tone="warn">
          Round {nextRound} closes in <Countdown deadline={nextDeadline} /> and you have not picked yet.
          {league.league.noPickPolicy === 'eliminate'
            ? ' Miss it and you are out.'
            : ' Miss it and you will be given the next club you have not used, alphabetically.'}{' '}
          <Link to={`/leagues/${league.league.id}/pick`}>Pick now</Link>
        </Alert>
      )}

      <Card>
        <div className="grid-3">
          <Stat value={overview.totalEntries} label="Entrants" />
          <Stat value={overview.active} label="Still in" tone="accent" />
          <Stat value={overview.eliminated} label="Knocked out" tone="danger" />
        </div>
        <div style={{ marginTop: 14 }}>
          <div className="spread tiny muted" style={{ marginBottom: 6 }}>
            <span>{overview.survivalPct}% of the field surviving</span>
            <span>
              {league.league.status === 'completed'
                ? 'Competition finished'
                : nextDeadline
                  ? <>Round {nextRound} deadline <Countdown deadline={nextDeadline} /></>
                  : 'No further rounds scheduled'}
            </span>
          </div>
          <Bar pct={overview.survivalPct} />
          {nextDeadline && (
            <div className="tiny dim" style={{ marginTop: 6 }}>{formatDateTime(nextDeadline)}</div>
          )}
        </div>
      </Card>

      {isPlayer && (
        <Card title="My picks">
          {picks.length === 0 && <Empty>No picks yet.</Empty>}
          <div className="list">
            {picks.map((pick) => (
              <div key={pick.round} className="timeline-item">
                <div className={`round-chip ${outcomeClass(pick.result)}`}>
                  <span>R{pick.round}</span>
                  <span className="tiny dim">GW{pick.gameweek}</span>
                </div>
                <div className="grow">
                  <div className="strong">
                    {pick.team}
                    {pick.autoAssigned && <span className="badge badge-warn" style={{ marginLeft: 7 }}>Auto</span>}
                    {pick.needsReselect && <span className="badge badge-warn" style={{ marginLeft: 7 }}>Pick again</span>}
                  </div>
                  <div className="tiny muted">
                    {pick.autoAssigned ? 'Given to you — no pick before the deadline' : formatDateTime(pick.deadline)}
                  </div>
                </div>
                <span className={`badge ${
                  pick.result === 'survived' ? 'badge-in' : pick.result === 'eliminated' ? 'badge-out' : 'badge-pending'
                }`}>
                  {OUTCOME_LABEL[pick.outcome] ?? pick.outcome}
                </span>
              </div>
            ))}
          </div>
          {picks.length > 0 && (
            <p className="tiny dim" style={{ marginBottom: 0, marginTop: 10 }}>
              Clubs used this cycle cannot be picked again until all {league.league.teamCount} have been
              used — from round {league.league.teamCount + 1} everything resets.
            </p>
          )}
        </Card>
      )}

      {league.verification && (
        <div className="small" style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '0 2px' }}>
          <span className={`badge ${league.verification.ok ? 'badge-in' : 'badge-out'}`}>
            {league.verification.ok ? '✓ Checked' : '! Needs checking'}
          </span>
          <span className="tiny muted">
            {league.verification.ok
              ? `Every one of ${league.verification.picksChecked} picks re-checked against the fixtures.`
              : `${league.verification.errors} result${league.verification.errors === 1 ? '' : 's'} do not match the fixtures — the admins have been told.`}
          </span>
        </div>
      )}

      <Card title="Round by round">
        {overview.rounds.length === 0 && <Empty>Nothing settled yet — check back after the first round.</Empty>}
        <div className="list">
          {overview.rounds.map((round) => (
            <div key={round.round} className="stack" style={{ gap: 6, padding: '9px 0', borderBottom: '1px solid var(--line-soft)' }}>
              <div className="spread small">
                <span className="strong">Round {round.round} <span className="dim">· GW{round.gameweek}</span></span>
                <span className="muted">
                  {round.eliminated} out · {round.survivors} left
                </span>
              </div>
              <Bar pct={round.startedWith ? (round.eliminated / round.startedWith) * 100 : 0} out />
              <div className="tiny dim">{round.survivalPct}% survived this round</div>
            </div>
          ))}
        </div>
      </Card>

      <Card title={`Entrants (${standings.length})`}>
        <div className="list">
          {standings.map((row) => (
            <div key={row.entryId} className={`list-item${row.isMe ? ' me' : ''}`}>
              <div className="grow">
                <div className="strong">
                  {row.name}{row.isMe && <span className="tiny dim"> · you</span>}
                </div>
                <div className="tiny muted">
                  {row.status === 'active'
                    ? `${row.roundsSurvived} round${row.roundsSurvived === 1 ? '' : 's'} survived`
                    : row.status === 'withdrawn'
                      ? 'Withdrawn'
                      : `Out in round ${row.eliminatedRound}${
                          row.eliminatedReason ? ` — ${ELIMINATION_LABEL[row.eliminatedReason] ?? row.eliminatedReason}` : ''
                        }`}
                </div>
              </div>
              {row.isWinner
                ? <span className="badge badge-gold">Winner</span>
                : <span className={`badge ${row.status === 'active' ? 'badge-in' : 'badge-out'}`}>
                    {row.status === 'active' ? 'In' : 'Out'}
                  </span>}
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
