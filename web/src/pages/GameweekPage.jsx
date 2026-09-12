import { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { useLeague } from '../league.jsx';
import { Alert, Bar, Card, Countdown, Empty, Spinner } from '../components/ui.jsx';
import { formatShort } from '../lib/format.js';

const statusLabel = (fixture) => {
  if (fixture.status === 'live') return `${fixture.minute ?? 0}'`;
  if (fixture.status === 'finished') return 'FT';
  if (fixture.status === 'postponed') return 'Postponed';
  if (fixture.status === 'abandoned') return 'Abandoned';
  return formatShort(fixture.kickoff);
};

export default function GameweekPage() {
  const league = useLeague();
  const rounds = useMemo(
    () => Array.from({ length: 6 }, (_, index) => (league.league.focusRound ?? 1) - 2 + index)
      .filter((round) => round >= 1),
    [league.league.focusRound],
  );
  const [round, setRound] = useState(league.league.focusRound ?? 1);
  const [live, setLive] = useState(null);
  const [popularity, setPopularity] = useState(null);
  const [others, setOthers] = useState(null);
  const [error, setError] = useState('');

  // Snapshot on round change, then keep it fresh over Server-Sent Events.
  useEffect(() => {
    let cancelled = false;
    setLive(null);
    setError('');
    Promise.all([
      api.get(`/api/leagues/${league.leagueId}/rounds/${round}/fixtures`),
      api.get(`/api/leagues/${league.leagueId}/rounds/${round}/popularity`),
      api.get(`/api/leagues/${league.leagueId}/rounds/${round}/picks`),
    ])
      .then(([fixtures, pop, picks]) => {
        if (cancelled) return;
        setLive(fixtures);
        setPopularity(pop);
        setOthers(picks);
      })
      .catch((loadError) => !cancelled && setError(loadError.message));
    return () => { cancelled = true; };
  }, [league.leagueId, round]);

  useEffect(() => {
    const source = new EventSource(`/api/leagues/${league.leagueId}/live?round=${round}`);
    source.addEventListener('scores', (event) => {
      const payload = JSON.parse(event.data);
      if (payload.round === round) setLive(payload);
    });
    source.onerror = () => source.close();
    return () => source.close();
  }, [league.leagueId, round]);

  const anyLive = live?.fixtures?.some((fixture) => fixture.status === 'live');

  return (
    <div className="stack">
      <div className="spread">
        <div>
          <h1>Gameweek</h1>
          <div className="small muted">
            {live?.gameweek ? `Round ${round} · GW${live.gameweek}` : `Round ${round}`}
            {anyLive && <> · <span className="badge badge-live"><span className="live-dot" />Live</span></>}
          </div>
        </div>
        {live?.deadline && new Date(live.deadline) > new Date() && (
          <div className="small muted">Locks in <Countdown deadline={live.deadline} /></div>
        )}
      </div>

      <div className="segmented">
        {rounds.map((option) => (
          <button
            key={option}
            className={option === round ? 'active' : ''}
            onClick={() => setRound(option)}
            type="button"
          >
            R{option}
          </button>
        ))}
      </div>

      <Alert tone="error">{error}</Alert>
      {!live && !error && <Spinner />}

      {popularity && (
        <Card title={`Most picked · ${popularity.totalPicks} pick${popularity.totalPicks === 1 ? '' : 's'}`}>
          {popularity.teams.length === 0 && <Empty>Nobody has picked for this round yet.</Empty>}
          {popularity.teams.map((team) => (
            <div key={team.teamId} className="popularity-row">
              <div className="spread small">
                <span className="strong">{team.name}</span>
                <span className="muted">
                  {team.picks} · {team.pct}%
                </span>
              </div>
              <Bar pct={team.pct} />
            </div>
          ))}
          <p className="tiny dim" style={{ margin: '10px 0 0' }}>
            Only teams somebody has picked are listed.
          </p>
        </Card>
      )}

      {live && (
        <Card title="Fixtures and live scores">
          {live.fixtures.length === 0 && <Empty>No fixtures for this round.</Empty>}
          {live.fixtures.map((fixture) => (
            <div key={fixture.id} className="fixture">
              <div className="spread tiny muted">
                <span>{statusLabel(fixture)}</span>
                {fixture.status === 'live' && <span className="badge badge-live"><span className="live-dot" />Live</span>}
              </div>
              {['home', 'away'].map((side) => {
                const team = fixture[side];
                return (
                  <div className="fixture-side" key={side}>
                    <div className="fixture-team">
                      <span className="fixture-name">{team.name}</span>
                      {team.picks > 0 && (
                        <span className={`pick-count${team.pct >= 25 ? ' hot' : ''}`}>
                          {team.picks} · {team.pct}%
                        </span>
                      )}
                    </div>
                    <span className="fixture-score">
                      {fixture.status === 'scheduled' ? '–' : (side === 'home' ? fixture.homeScore : fixture.awayScore) ?? 0}
                    </span>
                  </div>
                );
              })}
            </div>
          ))}
          <p className="tiny dim" style={{ margin: '10px 0 0' }}>
            The count beside each team is how many entrants in this league are riding on them.
          </p>
        </Card>
      )}

      {others && (
        <Card title="Who picked what">
          {!others.revealed && <Empty>Picks stay hidden until the round locks.</Empty>}
          {others.revealed && others.picks.length === 0 && <Empty>No picks were made for this round.</Empty>}
          <div className="list">
            {others.revealed && others.picks.map((pick) => (
              <div key={pick.entryId} className="list-item">
                <span className="grow">{pick.name}</span>
                <span className="muted small">{pick.team}</span>
                <span className={`badge ${
                  pick.result === 'survived' ? 'badge-in' : pick.result === 'eliminated' ? 'badge-out' : 'badge-pending'
                }`}>
                  {pick.result === 'pending' ? '—' : pick.result === 'survived' ? 'Through' : 'Out'}
                </span>
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}
