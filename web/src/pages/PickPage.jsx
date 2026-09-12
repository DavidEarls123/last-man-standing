import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { useLeague } from '../league.jsx';
import { Alert, Card, Countdown, Spinner, Toast } from '../components/ui.jsx';
import { formatShort } from '../lib/format.js';

export default function PickPage() {
  const league = useLeague();
  const navigate = useNavigate();
  const { league: info, picks, reload } = league;

  // Before the entry deadline you choose the whole opening block; after it,
  // just the next round.
  const rounds = useMemo(() => {
    if (!info.entryClosed) {
      return Array.from({ length: info.initialPicks }, (_, index) => index + 1);
    }
    return info.nextOpenRound ? [info.nextOpenRound] : [];
  }, [info.entryClosed, info.initialPicks, info.nextOpenRound]);

  const [round, setRound] = useState(rounds[0] ?? 1);
  const [teams, setTeams] = useState(null);
  const [selected, setSelected] = useState(null);
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');
  const [busy, setBusy] = useState(false);

  const existing = picks.find((pick) => pick.round === round);

  useEffect(() => {
    setTeams(null);
    setError('');
    setSelected(null);
    api.get(`/api/leagues/${league.leagueId}/rounds/${round}/teams`)
      .then((data) => setTeams(data.teams))
      .catch((loadError) => setError(loadError.message));
  }, [league.leagueId, round]);

  async function save() {
    setBusy(true);
    setError('');
    try {
      await api.post(`/api/leagues/${league.leagueId}/picks`, { round, teamId: selected });
      await reload();
      setToast(`Round ${round} pick saved`);
      const next = rounds.filter((option) => option > round)[0];
      if (next) setRound(next);
      else navigate(`/leagues/${league.leagueId}`);
    } catch (saveError) {
      setError(saveError.message);
    } finally {
      setBusy(false);
    }
  }

  if (info.status === 'completed') {
    return <Card><Alert tone="info">This competition has finished.</Alert></Card>;
  }
  if (!info.entry || info.entry.status !== 'active') {
    return <Card><Alert tone="info">You are out of this competition, so there is nothing to pick.</Alert></Card>;
  }
  if (rounds.length === 0) {
    return <Card><Alert tone="info">No round is open for picking right now.</Alert></Card>;
  }

  return (
    <div className="stack">
      <div>
        <h1>Make your pick</h1>
        <p className="muted small" style={{ marginTop: 4 }}>
          {info.entryClosed
            ? 'One pick per round, and never the same team twice in a cycle.'
            : `Choose all ${info.initialPicks} opening rounds before entries close — ` }
          {!info.entryClosed && <Countdown deadline={info.entryDeadline} />}
        </p>
      </div>

      {rounds.length > 1 && (
        <div className="segmented">
          {rounds.map((option) => {
            const done = picks.some((pick) => pick.round === option);
            return (
              <button
                key={option}
                type="button"
                className={option === round ? 'active' : ''}
                onClick={() => setRound(option)}
              >
                Round {option}{done ? ' ✓' : ''}
              </button>
            );
          })}
        </div>
      )}

      {existing && (
        <Alert tone="info">
          Your round {round} pick is <strong>{existing.team}</strong>. You can change it until the deadline.
        </Alert>
      )}

      <Alert tone="error">{error}</Alert>
      {!teams && !error && <Spinner />}

      {teams && (
        <Card title={`Round ${round} — pick a winner`}>
          <div className="grid-auto">
            {teams.map((team) => {
              const isSelected = selected === team.teamId
                || (selected === null && existing?.teamId === team.teamId);
              return (
                <button
                  key={team.teamId}
                  type="button"
                  className={`team-btn${isSelected ? ' selected' : ''}`}
                  disabled={!team.available}
                  onClick={() => setSelected(team.teamId)}
                >
                  <span className="team-name">{team.name}</span>
                  <span className="team-meta">
                    {team.isCurrentPick && team.fixture
                      ? `Your pick · ${team.fixture.home ? 'v' : 'at'} ${team.fixture.opponentShort}`
                      : team.usedInRound
                      ? `Used in round ${team.usedInRound}`
                      : team.fixture
                        ? `${team.fixture.home ? 'v' : 'at'} ${team.fixture.opponentShort} · ${formatShort(team.fixture.kickoff)}`
                        : 'No fixture this gameweek'}
                  </span>
                </button>
              );
            })}
          </div>

          <div className="row" style={{ marginTop: 14 }}>
            <button
              className="btn-primary grow"
              type="button"
              disabled={busy || (!selected && !existing)}
              onClick={save}
            >
              {busy ? 'Saving…' : `Confirm round ${round} pick`}
            </button>
          </div>
          <p className="tiny dim" style={{ marginBottom: 0, marginTop: 10 }}>
            Greyed-out clubs are ones you have already used this cycle, or who have no fixture.
            A draw counts as not winning unless your league says otherwise.
          </p>
        </Card>
      )}

      <Toast message={toast} onDone={() => setToast('')} />
    </div>
  );
}
