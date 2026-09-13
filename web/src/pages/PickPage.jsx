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
  const reselect = league.reselection ?? [];
  const openRounds = league.openRounds ?? [];
  const owedOpening = league.owedOpeningRounds ?? [];
  const rounds = useMemo(() => {
    // A round whose fixture was called off reopens, even past its deadline.
    return [...new Set([...reselect.map((item) => item.round), ...openRounds])].sort((a, b) => a - b);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(openRounds), JSON.stringify(reselect)]);

  const [round, setRound] = useState(rounds[0] ?? 1);
  const [teams, setTeams] = useState(null);
  const [selected, setSelected] = useState(null);
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');
  const [busy, setBusy] = useState(false);

  const existing = picks.find((pick) => pick.round === round);
  const reselecting = reselect.find((item) => item.round === round);
  const locked = Boolean(existing?.locked) && !reselecting;
  const roundMarker = (option) => {
    const pick = picks.find((entry) => entry.round === option);
    if (!pick) return '';
    return pick.locked && !reselect.some((item) => item.round === option) ? ' 🔒' : ' ✓';
  };

  useEffect(() => {
    setTeams(null);
    setError('');
    setSelected(null);
    api.get(`/api/leagues/${league.leagueId}/rounds/${round}/teams`)
      .then((data) => setTeams(data.teams))
      .catch((loadError) => setError(loadError.message));
  }, [league.leagueId, round]);

  async function save() {
    const isOpening = info.openingPicks >= 2 && round <= info.openingPicks && !reselecting;
    if (isOpening) {
      const team = teams?.find((candidate) => candidate.teamId === selected);
      const confirmed = window.confirm(
        `Lock in ${team?.name ?? 'this club'} for round ${round}?\n\n`
        + 'Opening picks cannot be changed afterwards.',
      );
      if (!confirmed) return;
    }
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
          {owedOpening.length > 0
            ? `This league starts with ${info.openingPicks} picks, all due before the first kick off — and once made they are final.`
            : 'One pick per round, never the same club twice in a cycle. Pick as far ahead as you like.'}
          {' '}The deadline is the first kick off of the gameweek, the same for everyone.
        </p>
      </div>

      {rounds.length > 1 && (
        <>
          {rounds.length <= 5 ? (
            <div className="segmented">
              {rounds.map((option) => (
                <button
                  key={option}
                  type="button"
                  className={option === round ? 'active' : ''}
                  onClick={() => setRound(option)}
                >
                  Round {option}{roundMarker(option)}
                </button>
              ))}
            </div>
          ) : (
            <label className="field">
              Round
              <select value={round} onChange={(event) => setRound(Number(event.target.value))}>
                {rounds.map((option) => (
                  <option key={option} value={option}>
                    Round {option}
                    {option === rounds[0] ? ' — next up' : ''}
                    {roundMarker(option)}
                  </option>
                ))}
              </select>
            </label>
          )}
          <p className="tiny dim" style={{ margin: '-4px 0 0' }}>
            {owedOpening.length > 0
              ? `Rounds 1 to ${info.openingPicks} are due before the competition starts and cannot be changed once saved. Anything after that is optional and stays changeable until its gameweek kicks off.`
              : 'Only the round coming up needs a pick. Anything further ahead is optional, and stays changeable until its gameweek kicks off.'}
            {' '}A club you use in any round is gone until all {info.teamCount} have been used,
            whichever order you pick them in.
          </p>
        </>
      )}

      {reselecting ? (
        <Alert tone="warn">
          <strong>{reselecting.team}</strong>'s game is off, so pick again from whatever has not kicked off
          yet{reselecting.deadline ? <> — <Countdown deadline={reselecting.deadline} /> left</> : ''}.
          {' '}{reselecting.team} stays available for a later round.
        </Alert>
      ) : locked ? (
        <Alert tone="info">
          Your round {round} pick is <strong>{existing.team}</strong>. Opening picks are final, so this
          one is locked in.
        </Alert>
      ) : existing && (
        <Alert tone="info">
          Your round {round} pick is <strong>{existing.team}</strong>. You can change it until the deadline.
        </Alert>
      )}

      <Alert tone="error">{error}</Alert>
      {!teams && !error && <Spinner />}

      {teams && (
        <Card title={reselecting ? `Round ${round} — replacement pick` : `Round ${round} — pick a winner`}>
          <div className="grid-auto">
            {teams.map((team) => {
              const isSelected = selected === team.teamId
                || (selected === null && existing?.teamId === team.teamId);
              return (
                <button
                  key={team.teamId}
                  type="button"
                  className={`team-btn${isSelected ? ' selected' : ''}`}
                  disabled={!team.available || locked}
                  onClick={() => setSelected(team.teamId)}
                >
                  <span className="team-name">{team.name}</span>
                  <span className="team-meta">
                    {!team.available && team.fixture && !team.usedInRound
                      ? ['postponed', 'abandoned'].includes(team.fixture.status)
                        ? 'Game called off'
                        : 'Already kicked off'
                      : team.isCurrentPick && team.fixture
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
              disabled={busy || locked || !selected}
              onClick={save}
            >
              {busy ? 'Saving…' : locked ? 'Locked in' : `Confirm round ${round} pick`}
            </button>
          </div>
          <p className="tiny dim" style={{ marginBottom: 0, marginTop: 10 }}>
            {locked
              ? 'This round is settled as far as your entry goes — opening picks cannot be swapped.'
              : 'Greyed-out clubs are ones you have already used this cycle, or who have no game left to play.'}
            {' '}A draw counts as not winning unless your league says otherwise.
          </p>
        </Card>
      )}

      <Toast message={toast} onDone={() => setToast('')} />
    </div>
  );
}
