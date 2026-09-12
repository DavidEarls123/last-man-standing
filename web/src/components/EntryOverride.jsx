import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Alert, Card, Empty, Spinner, useAsync } from './ui.jsx';

/**
 * Super-admin-only editing of a league's entries: set a pick for any round,
 * reinstate someone knocked out in error, or knock someone out by hand.
 */
export default function EntryOverride({ leagueId, onChange }) {
  const { data, loading, error, reload } = useAsync(
    () => api.get(`/api/admin/leagues/${leagueId}/entries`), [leagueId],
  );
  const [selected, setSelected] = useState(null);
  const [round, setRound] = useState(1);
  const [teams, setTeams] = useState(null);
  const [teamId, setTeamId] = useState('');
  const [actionError, setActionError] = useState('');
  const [notice, setNotice] = useState('');

  useEffect(() => {
    if (!selected) return;
    setTeams(null);
    api.get(`/api/admin/leagues/${leagueId}/entries/${selected}/teams?round=${round}`)
      .then((result) => setTeams(result.teams))
      .catch((loadError) => setActionError(loadError.message));
  }, [leagueId, selected, round]);

  const act = (action) => async () => {
    setActionError('');
    setNotice('');
    try {
      await action();
      reload();
      onChange?.();
    } catch (runError) {
      setActionError(runError.message);
    }
  };

  if (loading) return <Spinner />;
  if (error) return <Alert tone="error">{error}</Alert>;

  const entry = data.entries.find((candidate) => candidate.entryId === selected);

  return (
    <Card title="Platform override">
      <p className="small muted" style={{ marginTop: 0 }}>
        Change a pick or an entry's status when something needs putting right. Every change is
        recorded in the audit log; run <strong>Recompute</strong> afterwards if results are involved.
      </p>

      <Alert tone="error">{actionError}</Alert>
      <Alert tone="ok">{notice}</Alert>

      <label className="field">
        Entry
        <select value={selected ?? ''} onChange={(event) => setSelected(Number(event.target.value) || null)}>
          <option value="">Choose a player…</option>
          {data.entries.map((candidate) => (
            <option key={candidate.entryId} value={candidate.entryId}>
              {candidate.name} — {candidate.status}
              {candidate.eliminatedRound ? ` (R${candidate.eliminatedRound})` : ''}
            </option>
          ))}
        </select>
      </label>

      {data.entries.length === 0 && <Empty>Nobody has entered this league.</Empty>}

      {entry && (
        <div className="stack" style={{ marginTop: 12 }}>
          <div className="small muted">
            Picks:{' '}
            {entry.picks.length
              ? entry.picks.map((pick) => `R${pick.round} ${pick.team} (${pick.outcome})`).join(', ')
              : 'none yet'}
          </div>

          <div className="grid-2">
            <label className="field">
              Round
              <select value={round} onChange={(event) => setRound(Number(event.target.value))}>
                {data.rounds.map((option) => (
                  <option key={option.round} value={option.round}>
                    Round {option.round} · GW{option.gameweek}
                    {option.settled ? ' (settled)' : option.deadlinePassed ? ' (locked)' : ''}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              Team
              <select value={teamId} onChange={(event) => setTeamId(event.target.value)}>
                <option value="">Choose a team…</option>
                {teams?.map((team) => (
                  <option key={team.teamId} value={team.teamId}>
                    {team.name}
                    {team.usedInRound ? ` — used in R${team.usedInRound}` : ''}
                    {!team.fixture ? ' — no fixture' : ''}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <button className="btn-primary" type="button" disabled={!teamId} onClick={act(async () => {
            await api.post(`/api/admin/leagues/${leagueId}/entries/${entry.entryId}/pick`, {
              round, teamId: Number(teamId),
            });
            setTeamId('');
            setNotice(`Round ${round} pick set for ${entry.name}`);
          })}>Set pick</button>

          <div className="divider" />

          <div className="row">
            <button className="btn-ghost btn-sm" type="button" onClick={act(async () => {
              await api.patch(`/api/admin/entries/${entry.entryId}`, { status: 'active', eliminatedRound: null });
              setNotice(`${entry.name} reinstated`);
            })}>Reinstate</button>
            <button className="btn-danger btn-sm" type="button" onClick={act(async () => {
              await api.patch(`/api/admin/entries/${entry.entryId}`, { status: 'eliminated', eliminatedRound: round });
              setNotice(`${entry.name} eliminated in round ${round}`);
            })}>Eliminate in round {round}</button>
            <button className="btn-ghost btn-sm" type="button" onClick={act(async () => {
              await api.post(`/api/admin/leagues/${leagueId}/recompute`);
              setNotice('League recomputed from the fixtures');
            })}>Recompute league</button>
          </div>
        </div>
      )}
    </Card>
  );
}
