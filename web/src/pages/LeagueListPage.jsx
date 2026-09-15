import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { Alert, Bar, Card, Countdown, Empty, Spinner, useAsync } from '../components/ui.jsx';
import LeagueCrest from '../components/LeagueCrest.jsx';

export default function LeagueListPage() {
  const navigate = useNavigate();
  const { data, loading, error, reload } = useAsync(() => api.get('/api/leagues'));
  const [code, setCode] = useState('');
  const [joining, setJoining] = useState(false);
  const [joinError, setJoinError] = useState('');
  const [busy, setBusy] = useState(false);

  async function join(event) {
    event.preventDefault();
    setJoinError('');
    setBusy(true);
    try {
      const { league } = await api.post('/api/leagues/join', { code: code.trim().toUpperCase() });
      navigate(`/leagues/${league.id}`);
    } catch (submitError) {
      setJoinError(submitError.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack">
      {/* No heading: the game bar above already says where you are, and what
          follows is simply the leagues in it. Joining is a button, because you
          do it once and then never again. */}
      <div className="list-toolbar">
        <button
          type="button"
          className="btn-ghost btn-sm"
          aria-expanded={joining}
          onClick={() => { setJoining(!joining); setJoinError(''); }}
        >
          {joining ? 'Cancel' : '+ Join a league'}
        </button>
        <div className="grow" />
        {data && <button className="btn-ghost btn-sm" onClick={reload}>Refresh</button>}
      </div>

      {joining && (
        <Card title="Join a league">
          <form className="row" onSubmit={join}>
            <input
              className="grow mono"
              style={{ textTransform: 'uppercase', letterSpacing: '0.12em' }}
              placeholder="ENTER CODE"
              value={code}
              onChange={(event) => setCode(event.target.value)}
              maxLength={12}
              autoFocus
              required
            />
            <button className="btn-primary" type="submit" disabled={busy}>Join</button>
          </form>
          <p className="tiny dim" style={{ marginBottom: 0 }}>
            Your league admin shares a six-character code or an invite link.
          </p>
          <Alert tone="error">{joinError}</Alert>
        </Card>
      )}

      {loading && <Spinner />}
      <Alert tone="error">{error}</Alert>

      {data && data.leagues.length === 0 && (
        <Card><Empty>
          You are not in any Last One Standing leagues yet. Use <strong>Join a league</strong> above
          with the code your league admin gave you.
        </Empty></Card>
      )}

      {data?.leagues.map((league) => {
        const survivalPct = league.totalEntries ? (league.active / league.totalEntries) * 100 : 0;
        return (
          <Link
            key={league.id}
            to={`/leagues/${league.id}`}
            className="league-card"
            style={{ '--brand': league.primaryColor, '--brand-2': league.secondaryColor }}
          >
            {/* The header is the league's own two colours and its crest, so the
                card is a real preview of what is behind the door. */}
            <div className="league-card-head">
              <LeagueCrest league={league} className="league-crest" size={50} />
              <div className="grow">
                <h2 className="league-card-name">{league.name}</h2>
                <div className="league-card-tag">
                  {league.tagline || `Starts gameweek ${league.startGameweek}`}
                </div>
              </div>
              <div className="row-tight league-card-badges">
                {!league.launched && <span className="badge badge-warn">Draft</span>}
                {league.role === 'admin' && <span className="badge badge-admin">Admin</span>}
                {league.role === 'super_admin' && <span className="badge badge-admin">Platform</span>}
                {league.entry?.isWinner && <span className="badge badge-gold">Winner</span>}
                {league.entry && !league.entry.isWinner && (
                  <span className={`badge ${league.entry.status === 'active' ? 'badge-in' : 'badge-out'}`}>
                    {league.entry.status === 'active' ? 'In' : 'Out'}
                  </span>
                )}
              </div>
            </div>

            <div className="league-card-body">
              <div className="league-card-stats">
                <span><strong>{league.active}</strong> still standing</span>
                <span className="dot-sep" aria-hidden="true">·</span>
                <span><strong>{league.totalEntries}</strong> entrant{league.totalEntries === 1 ? '' : 's'}</span>
                {league.entry?.status === 'eliminated' && league.entry.eliminatedRound && (
                  <>
                    <span className="dot-sep" aria-hidden="true">·</span>
                    <span>you went out in round {league.entry.eliminatedRound}</span>
                  </>
                )}
              </div>
              <Bar pct={survivalPct} />
              <div className="spread tiny muted">
                <span>{Math.round(survivalPct)}% of the field left</span>
                <span>
                  {league.status === 'completed'
                    ? 'Completed'
                    : !league.launched
                      ? 'Not launched yet'
                      : league.entryClosed
                        ? <>Round {league.nextOpenRound} in <Countdown deadline={league.nextDeadline} /></>
                        : <>Entries close in <Countdown deadline={league.entryDeadline} /></>}
                </span>
              </div>
            </div>
          </Link>
        );
      })}

    </div>
  );
}
