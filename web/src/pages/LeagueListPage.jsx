import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { Alert, Bar, Card, Countdown, Empty, Spinner, useAsync } from '../components/ui.jsx';
import LeagueCrest from '../components/LeagueCrest.jsx';

export default function LeagueListPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const { data, loading, error, reload } = useAsync(() => api.get('/api/leagues'));
  const [code, setCode] = useState('');
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
      <div>
        <h1>Hello {user.displayName.split(' ')[0]}</h1>
        <p className="muted small" style={{ marginTop: 4 }}>
          Your leagues, and the ones you run.
        </p>
      </div>

      <Card title="Join a league">
        <form className="row" onSubmit={join}>
          <input
            className="grow mono"
            style={{ textTransform: 'uppercase', letterSpacing: '0.12em' }}
            placeholder="ENTER CODE"
            value={code}
            onChange={(event) => setCode(event.target.value)}
            maxLength={12}
            required
          />
          <button className="btn-primary" type="submit" disabled={busy}>Join</button>
        </form>
        <p className="tiny dim" style={{ marginBottom: 0 }}>
          Your league admin shares a six-character code or an invite link.
        </p>
        <Alert tone="error">{joinError}</Alert>
      </Card>

      {loading && <Spinner />}
      <Alert tone="error">{error}</Alert>

      {data && data.leagues.length === 0 && (
        <Card><Empty>You are not in any leagues yet. Join one with a code above.</Empty></Card>
      )}

      {data?.leagues.map((league) => {
        const survivalPct = league.totalEntries ? (league.active / league.totalEntries) * 100 : 0;
        return (
          <Link
            key={league.id}
            to={`/leagues/${league.id}`}
            style={{
              textDecoration: 'none',
              color: 'inherit',
              '--brand': league.primaryColor,
              '--brand-2': league.secondaryColor,
            }}
          >
            <Card>
              <div className="spread">
                <LeagueCrest league={league} className="logo-preview" size={44} />
                <div className="grow">
                  <h2>{league.name}</h2>
                  <div className="small muted">
                    {league.tagline || `Starts gameweek ${league.startGameweek}`} · {league.totalEntries} entrant
                    {league.totalEntries === 1 ? '' : 's'}
                  </div>
                </div>
                <div className="row-tight">
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

              <div style={{ marginTop: 12 }}>
                <Bar pct={survivalPct} />
                <div className="spread tiny muted" style={{ marginTop: 6 }}>
                  <span>{league.active} still standing</span>
                  <span>
                    {league.status === 'completed'
                      ? 'Completed'
                      : league.entryClosed
                        ? <>Round {league.nextOpenRound} in <Countdown deadline={league.nextDeadline} /></>
                        : <>Entries close in <Countdown deadline={league.entryDeadline} /></>}
                  </span>
                </div>
              </div>
            </Card>
          </Link>
        );
      })}

      {data && (
        <button className="btn-ghost btn-sm" onClick={reload} style={{ justifySelf: 'center' }}>Refresh</button>
      )}
    </div>
  );
}
