import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { useLeague } from '../league.jsx';
import { Alert, Card, Countdown, Spinner, Toast } from '../components/ui.jsx';
import RoundStrip, { roundToneFor } from '../components/RoundStrip.jsx';
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

  const current = info.focusRound ?? info.nextOpenRound ?? rounds[0] ?? 1;
  const lastRound = info.lastRound ?? Math.max(current, rounds[rounds.length - 1] ?? 1);
  const openSet = useMemo(() => new Set(rounds), [rounds]);

  const [round, setRound] = useState(rounds[0] ?? 1);
  const [teams, setTeams] = useState(null);
  const [selected, setSelected] = useState(null);
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');
  const [busy, setBusy] = useState(false);

  const existing = picks.find((pick) => pick.round === round);
  const reselecting = reselect.find((item) => item.round === round);
  const locked = Boolean(existing?.locked) && !reselecting;
  // Rounds you may still act on stay live in the strip; the rest are there so
  // you can look back at how the season has gone, not to be picked again.
  const openForPicking = openSet.has(round);
  const stateFor = (option) => {
    const base = roundToneFor(option, {
      current,
      picks,
      lastSettledRound: info.lastSettledRound ?? 0,
    });
    const pick = picks.find((entry) => entry.round === option);
    const needsReselect = reselect.some((item) => item.round === option);
    if (openSet.has(option)) {
      const marker = needsReselect ? '↺' : pick ? (pick.locked ? '🔒' : '✓') : '';
      return {
        ...base,
        marker: marker || base.marker,
        title: needsReselect
          ? `Round ${option} — pick again`
          : pick ? `Round ${option} — ${pick.team}` : `Round ${option} — no pick yet`,
      };
    }
    return {
      ...base,
      disabled: false,
      title: pick ? `Round ${option} — ${pick.team} (closed)` : `Round ${option} — closed`,
    };
  };

  useEffect(() => {
    setTeams(null);
    setError('');
    setSelected(null);
    if (!openSet.has(round)) return undefined;
    let cancelled = false;
    api.get(`/api/leagues/${league.leagueId}/rounds/${round}/teams`)
      .then((data) => !cancelled && setTeams(data.teams))
      .catch((loadError) => !cancelled && setError(loadError.message));
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [league.leagueId, round, openForPicking]);

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

      <RoundStrip
        lastRound={lastRound}
        value={round}
        current={current}
        onChange={setRound}
        stateFor={stateFor}
      />
      <p className="tiny dim" style={{ margin: '-4px 0 0' }}>
        {owedOpening.length > 0
          ? `Rounds 1 to ${info.openingPicks} are due before the competition starts and cannot be changed once saved. Anything after that is optional and stays changeable until its gameweek kicks off.`
          : 'Only the round coming up needs a pick. Anything further ahead is optional, and stays changeable until its gameweek kicks off.'}
        {' '}A club you use in any round is gone until all {info.teamCount} have been used,
        whichever order you pick them in. Scroll the strip to look further back or further ahead.
      </p>

      {!openForPicking ? (
        <Card title={`Round ${round} — closed`}>
          {existing ? (
            <>
              <p style={{ margin: 0 }}>
                You picked <strong>{existing.team}</strong>
                {existing.autoAssigned && ' (assigned for you when the deadline passed)'}.
              </p>
              <p className="small muted" style={{ marginTop: 6, marginBottom: 0 }}>
                {existing.result === 'survived' ? 'They won, so you went through.'
                  : existing.result === 'eliminated' ? 'They did not win, so that was your run over.'
                  : 'Still waiting on the result.'}
              </p>
            </>
          ) : (
            <p className="muted" style={{ margin: 0 }}>
              You had no pick in this round.
            </p>
          )}
          <p className="tiny dim" style={{ marginBottom: 0, marginTop: 10 }}>
            This round has kicked off, so nothing can be changed. Tap an orange or grey round to pick.
          </p>
        </Card>
      ) : reselecting ? (
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
      {openForPicking && !teams && !error && <Spinner />}

      {openForPicking && teams && (
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
