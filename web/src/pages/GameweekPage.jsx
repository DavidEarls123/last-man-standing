import { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { useLeague } from '../league.jsx';
import { Alert, Bar, Card, Countdown, Empty, Spinner } from '../components/ui.jsx';
import RoundStrip, { roundToneFor } from '../components/RoundStrip.jsx';
import { formatShort } from '../lib/format.js';

const statusLabel = (fixture) => {
  if (fixture.status === 'live') return `${fixture.minute ?? 0}'`;
  if (fixture.status === 'finished') return 'FT';
  if (fixture.status === 'postponed') return 'Postponed';
  if (fixture.status === 'abandoned') return 'Abandoned';
  return formatShort(fixture.kickoff);
};

/** How a club themselves got on, once there is anything to say about it. */
function outcomeBadge(team) {
  const { status, scored, conceded } = team;
  if (!status || status === 'postponed' || status === 'abandoned') {
    return { className: 'void', label: 'Called off' };
  }
  if (status === 'scheduled' || scored == null || conceded == null) {
    const opponent = team.opponentShort ? `${team.home ? 'v' : 'at'} ${team.opponentShort}` : 'To play';
    return { className: 'pending', label: opponent };
  }
  const score = ` ${scored}-${conceded}`;
  if (status === 'live') {
    const state = scored > conceded ? 'Winning' : scored < conceded ? 'Losing' : 'Level';
    return { className: 'live', label: `${state}${score}` };
  }
  if (scored > conceded) return { className: 'win', label: `Won${score}` };
  if (scored === conceded) return { className: 'draw', label: `Drew${score}` };
  return { className: 'loss', label: `Lost${score}` };
}

export default function GameweekPage() {
  const league = useLeague();
  const current = league.league.focusRound ?? 1;
  const lastRound = league.league.lastRound ?? current;
  const [round, setRound] = useState(current);
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

  // Scores arrive over the event stream against fixtures, so fold them back
  // onto the popularity list to keep both halves of the tab in step.
  const liveByTeam = useMemo(() => {
    const map = new Map();
    for (const fixture of live?.fixtures ?? []) {
      const shared = { status: fixture.status };
      map.set(fixture.home.teamId, {
        ...shared, scored: fixture.homeScore, conceded: fixture.awayScore,
        opponentShort: fixture.away.shortName, home: true,
      });
      map.set(fixture.away.teamId, {
        ...shared, scored: fixture.awayScore, conceded: fixture.homeScore,
        opponentShort: fixture.home.shortName, home: false,
      });
    }
    return map;
  }, [live]);

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

      <RoundStrip
        lastRound={lastRound}
        value={round}
        current={current}
        onChange={setRound}
        stateFor={(option) => roundToneFor(option, {
          current,
          picks: league.picks ?? [],
          lastSettledRound: league.league.lastSettledRound ?? 0,
        })}
      />

      <Alert tone="error">{error}</Alert>
      {!live && !error && <Spinner />}

      <div className="columns">
      {popularity && (
        <Card title={`Most picked · ${popularity.totalPicks} pick${popularity.totalPicks === 1 ? '' : 's'}`}>
          {popularity.teams.length === 0 && <Empty>Nobody has picked for this round yet.</Empty>}
          {popularity.teams.map((team) => {
            const badge = outcomeBadge({ ...team, ...(liveByTeam.get(team.teamId) ?? {}) });
            return (
              <div key={team.teamId} className="popularity-row">
                <div className="popularity-head small">
                  <span className="strong grow">{team.name}</span>
                  <span className={`pop-outcome ${badge.className}`}>{badge.label}</span>
                  <span className="muted">{team.picks} · {team.pct}%</span>
                </div>
                <Bar pct={team.pct} />
              </div>
            );
          })}
          <p className="tiny dim" style={{ margin: '10px 0 0' }}>
            Only teams somebody has picked are listed. The tag beside each one is how that club
            got on — everyone who backed them shares it.
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
      </div>

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
