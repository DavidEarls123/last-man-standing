import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { Alert, Card, Empty, Spinner, Stat, Toast, useAsync } from '../components/ui.jsx';
import { formatShort } from '../lib/format.js';

const SECTIONS = ['Overview', 'Leagues', 'People', 'Results', 'Checks', 'Notifications', 'Security', 'Audit'];

export default function SuperAdminPage() {
  const [section, setSection] = useState('Overview');
  const [toast, setToast] = useState('');
  const [error, setError] = useState('');

  const shared = { setToast, setError };

  return (
    <div className="stack">
      <div>
        <h1>Platform administration</h1>
        <p className="muted small" style={{ marginTop: 4 }}>
          Everything on the platform: leagues, their admins, people, results and notifications.
        </p>
      </div>

      <div className="segmented">
        {SECTIONS.map((name) => (
          <button key={name} type="button" className={name === section ? 'active' : ''} onClick={() => setSection(name)}>
            {name}
          </button>
        ))}
      </div>

      <Alert tone="error">{error}</Alert>

      {section === 'Overview' && <OverviewSection {...shared} />}
      {section === 'Leagues' && <LeaguesSection {...shared} />}
      {section === 'People' && <PeopleSection {...shared} />}
      {section === 'Results' && <ResultsSection {...shared} />}
      {section === 'Checks' && <ChecksSection {...shared} />}
      {section === 'Notifications' && <NotificationsSection {...shared} />}
      {section === 'Security' && <SecuritySection {...shared} />}
      {section === 'Audit' && <AuditSection />}

      <Toast message={toast} onDone={() => setToast('')} />
    </div>
  );
}

function OverviewSection() {
  const { data, loading, error } = useAsync(() => api.get('/api/admin/overview'));
  if (loading) return <Spinner />;
  if (error) return <Alert tone="error">{error}</Alert>;

  return (
    <div className="stack">
      <Card title="At a glance">
        <div className="grid-3">
          <Stat value={data.counts.users} label="Accounts" />
          <Stat value={data.counts.leagues} label="Leagues" />
          <Stat value={data.counts.activeLeagues} label="Running" tone="accent" />
          <Stat value={data.counts.entries} label="Entries" />
          <Stat value={data.counts.queuedNotifications} label="Queued msgs" />
          <Stat value={data.counts.failedNotifications} label="Failed msgs" tone={data.counts.failedNotifications ? 'danger' : undefined} />
        </div>
      </Card>

      <Card title="Leagues">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>League</th><th>Admin</th><th>Code</th><th>Start</th><th>Entries</th><th>Status</th><th />
              </tr>
            </thead>
            <tbody>
              {data.leagues.map((league) => (
                <tr key={league.id}>
                  <td>{league.name}</td>
                  <td className="muted">{league.admin?.name ?? <span className="dim">unassigned</span>}</td>
                  <td className="mono">{league.joinCode}</td>
                  <td>GW{league.startGameweek}</td>
                  <td>{league.active}/{league.entries}</td>
                  <td>
                    <span className={`badge ${league.status === 'completed' ? 'badge-gold' : 'badge-in'}`}>
                      {league.status}
                    </span>
                  </td>
                  <td><Link to={`/leagues/${league.id}`}>open</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {data.leagues.length === 0 && <Empty>No leagues yet — create one under Leagues.</Empty>}
      </Card>
    </div>
  );
}

function LeaguesSection({ setToast, setError }) {
  const seasons = useAsync(() => api.get('/api/admin/seasons'));
  const overview = useAsync(() => api.get('/api/admin/overview'));
  const [form, setForm] = useState({
    name: '', startGameweek: 1, adminEmail: '', initialPicks: 3,
    drawPolicy: 'eliminate', voidPolicy: 'reselect', noPickPolicy: 'auto_alphabetical', seasonId: '',
  });

  useEffect(() => {
    if (!form.seasonId && seasons.data?.seasons?.length) {
      const current = seasons.data.seasons.find((season) => season.is_current) ?? seasons.data.seasons[0];
      setForm((previous) => ({ ...previous, seasonId: String(current.id) }));
    }
  }, [seasons.data, form.seasonId]);

  async function create(event) {
    event.preventDefault();
    setError('');
    try {
      const { league } = await api.post('/api/admin/leagues', {
        name: form.name,
        seasonId: Number(form.seasonId),
        startGameweek: Number(form.startGameweek),
        adminEmail: form.adminEmail || undefined,
        initialPicks: Number(form.initialPicks),
        drawPolicy: form.drawPolicy,
        voidPolicy: form.voidPolicy,
        noPickPolicy: form.noPickPolicy,
      });
      setToast(`Created "${league.name}" — join code ${league.join_code}`);
      setForm({ ...form, name: '', adminEmail: '' });
      overview.reload();
    } catch (createError) {
      setError(createError.message);
    }
  }

  return (
    <div className="stack">
      <Card title="Create a league">
        <form className="stack" onSubmit={create}>
          <label className="field">
            League name
            <input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} required />
          </label>
          <div className="grid-2">
            <label className="field">
              Season
              <select value={form.seasonId} onChange={(event) => setForm({ ...form, seasonId: event.target.value })}>
                {seasons.data?.seasons.map((season) => (
                  <option key={season.id} value={season.id}>
                    {season.name} ({season.gameweeks} GWs)
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              Start gameweek
              <input type="number" min="1" max="38" value={form.startGameweek}
                onChange={(event) => setForm({ ...form, startGameweek: event.target.value })} />
            </label>
          </div>
          <label className="field">
            League admin (email of an existing account)
            <input type="email" value={form.adminEmail} placeholder="leave blank to assign later"
              onChange={(event) => setForm({ ...form, adminEmail: event.target.value })} />
          </label>
          <div className="grid-2">
            <label className="field">
              Opening picks
              <input type="number" min="1" max="10" value={form.initialPicks}
                onChange={(event) => setForm({ ...form, initialPicks: event.target.value })} />
            </label>
            <label className="field">
              A draw
              <select value={form.drawPolicy} onChange={(event) => setForm({ ...form, drawPolicy: event.target.value })}>
                <option value="eliminate">Knocks you out</option>
                <option value="survive">Counts as surviving</option>
              </select>
            </label>
            <label className="field">
              Postponed / no fixture
              <select value={form.voidPolicy} onChange={(event) => setForm({ ...form, voidPolicy: event.target.value })}>
                <option value="reselect">Ask them to pick again</option>
                <option value="survive">Counts as surviving</option>
                <option value="eliminate">Knocks you out</option>
              </select>
            </label>
            <label className="field">
              No pick by the deadline
              <select value={form.noPickPolicy} onChange={(event) => setForm({ ...form, noPickPolicy: event.target.value })}>
                <option value="auto_alphabetical">Give them the next unused club (A–Z)</option>
                <option value="eliminate">Knocks you out</option>
              </select>
            </label>
          </div>
          <button className="btn-primary" type="submit">Create league</button>
        </form>
      </Card>

      <Card title="Existing leagues">
        {overview.loading && <Spinner />}
        <div className="list">
          {overview.data?.leagues.map((league) => (
            <LeagueRow key={league.id} league={league} onChange={overview.reload} setToast={setToast} setError={setError} />
          ))}
        </div>
      </Card>
    </div>
  );
}

function LeagueRow({ league, onChange, setToast, setError }) {
  const [adminEmail, setAdminEmail] = useState('');

  const act = (action) => async () => {
    setError('');
    try {
      await action();
      onChange();
    } catch (actionError) {
      setError(actionError.message);
    }
  };

  return (
    <div className="stack" style={{ gap: 8, padding: '11px 0', borderBottom: '1px solid var(--line-soft)' }}>
      <div className="spread">
        <div className="grow">
          <div className="strong">{league.name}</div>
          <div className="tiny muted">
            GW{league.startGameweek} · code <span className="mono">{league.joinCode}</span> ·{' '}
            {league.admin ? `admin ${league.admin.name}` : 'no admin assigned'}
            {league.configLocked && ' · setup locked'}
          </div>
        </div>
        <span className="badge badge-pending">{league.status}</span>
      </div>
      <div className="row">
        <input
          className="grow" placeholder="new admin email" value={adminEmail}
          onChange={(event) => setAdminEmail(event.target.value)}
        />
        <button className="btn-sm btn-ghost" type="button" disabled={!adminEmail} onClick={act(async () => {
          await api.patch(`/api/admin/leagues/${league.id}`, { adminEmail });
          setAdminEmail('');
          setToast('League admin updated');
        })}>Set admin</button>
        <button className="btn-sm btn-ghost" type="button" onClick={act(async () => {
          await api.post(`/api/admin/leagues/${league.id}/recompute`);
          setToast('League recomputed from the fixtures');
        })}>Recompute</button>
        <button className="btn-sm btn-danger" type="button" onClick={act(async () => {
          if (!window.confirm(`Archive "${league.name}"?`)) return;
          await api.del(`/api/admin/leagues/${league.id}`);
          setToast('League archived');
        })}>Archive</button>
      </div>
    </div>
  );
}

function PeopleSection({ setToast, setError }) {
  const [query, setQuery] = useState('');
  const { data, loading, reload } = useAsync(() => api.get(`/api/admin/users?q=${encodeURIComponent(query)}`), [query]);
  const [form, setForm] = useState({ displayName: '', email: '', phone: '' });
  const [created, setCreated] = useState(null);

  const act = (action) => async (event) => {
    event?.preventDefault();
    setError('');
    try {
      await action();
      reload();
    } catch (actionError) {
      setError(actionError.message);
    }
  };

  return (
    <div className="stack">
      <Card title="Create an account">
        <form className="stack" onSubmit={act(async () => {
          const result = await api.post('/api/admin/users', {
            displayName: form.displayName,
            email: form.email || undefined,
            phone: form.phone || undefined,
          });
          setCreated(result);
          setForm({ displayName: '', email: '', phone: '' });
          setToast('Account created');
        })}>
          <div className="grid-2">
            <label className="field">
              Name
              <input value={form.displayName} onChange={(event) => setForm({ ...form, displayName: event.target.value })} required />
            </label>
            <label className="field">
              Email
              <input type="email" value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} />
            </label>
          </div>
          <label className="field">
            Mobile
            <input value={form.phone} onChange={(event) => setForm({ ...form, phone: event.target.value })} />
          </label>
          <button className="btn-primary" type="submit">Create account</button>
        </form>
        {created?.temporaryPassword && (
          <Alert tone="ok">
            Temporary password for {created.user.displayName}:{' '}
            <strong className="mono">{created.temporaryPassword}</strong>
          </Alert>
        )}
        <p className="tiny dim" style={{ marginBottom: 0 }}>
          Make someone a league admin by creating their account here, then assigning them under Leagues.
        </p>
      </Card>

      <Card title="People">
        <input placeholder="Search name, email or phone" value={query} onChange={(event) => setQuery(event.target.value)} />
        {loading && <Spinner />}
        <div className="list" style={{ marginTop: 10 }}>
          {data?.users.map((user) => (
            <div key={user.id} className="list-item">
              <div className="grow">
                <div className="strong">
                  {user.displayName}
                  {user.isSuperAdmin && <span className="badge badge-admin" style={{ marginLeft: 8 }}>Platform</span>}
                  {user.adminOf.length > 0 && <span className="badge badge-admin" style={{ marginLeft: 8 }}>League admin</span>}
                </div>
                <div className="tiny muted">
                  {[user.email, user.phone].filter(Boolean).join(' · ')} · {user.leagues} league{user.leagues === 1 ? '' : 's'}
                  {user.status !== 'active' && ' · suspended'}
                </div>
              </div>
              <button className="btn-sm btn-ghost" type="button" onClick={act(async () => {
                const result = await api.patch(`/api/admin/users/${user.id}`, { resetPassword: true });
                window.alert(`Temporary password for ${user.displayName}:\n\n${result.temporaryPassword}`);
                setToast('Password reset');
              })}>Reset password</button>
              {!user.isSuperAdmin && (
                <button className="btn-sm btn-danger" type="button" onClick={act(async () => {
                  await api.patch(`/api/admin/users/${user.id}`, {
                    status: user.status === 'active' ? 'suspended' : 'active',
                  });
                  setToast(user.status === 'active' ? 'Account suspended' : 'Account restored');
                })}>{user.status === 'active' ? 'Suspend' : 'Restore'}</button>
              )}
            </div>
          ))}
        </div>
        {data?.users.length === 0 && <Empty>Nobody matches that search.</Empty>}
      </Card>
    </div>
  );
}

function ResultsSection({ setToast, setError }) {
  const seasons = useAsync(() => api.get('/api/admin/seasons'));
  const [seasonId, setSeasonId] = useState(null);
  const [gameweek, setGameweek] = useState(1);

  useEffect(() => {
    if (!seasonId && seasons.data?.seasons?.length) {
      const current = seasons.data.seasons.find((season) => season.is_current) ?? seasons.data.seasons[0];
      setSeasonId(current.id);
    }
  }, [seasons.data, seasonId]);

  const weeks = useAsync(
    () => (seasonId ? api.get(`/api/admin/seasons/${seasonId}/gameweeks`) : Promise.resolve({ gameweeks: [] })),
    [seasonId],
  );
  const current = weeks.data?.gameweeks.find((week) => week.number === Number(gameweek));

  const save = (fixture, patch) => async () => {
    setError('');
    try {
      await api.patch(`/api/admin/fixtures/${fixture.id}`, patch);
      weeks.reload();
      setToast('Fixture updated — affected leagues re-settled');
    } catch (saveError) {
      setError(saveError.message);
    }
  };

  return (
    <div className="stack">
      <Card title="Fixtures and results">
        <p className="small muted" style={{ marginTop: 0 }}>
          Correcting a score here re-settles every league that used it.
        </p>
        <div className="grid-2">
          <label className="field">
            Season
            <select value={seasonId ?? ''} onChange={(event) => setSeasonId(Number(event.target.value))}>
              {seasons.data?.seasons.map((season) => (
                <option key={season.id} value={season.id}>{season.name}</option>
              ))}
            </select>
          </label>
          <label className="field">
            Gameweek
            <select value={gameweek} onChange={(event) => setGameweek(Number(event.target.value))}>
              {weeks.data?.gameweeks.map((week) => (
                <option key={week.id} value={week.number}>GW{week.number}</option>
              ))}
            </select>
          </label>
        </div>
      </Card>

      {weeks.loading && <Spinner />}
      {current && (
        <Card title={`GW${current.number} · deadline ${formatShort(current.deadline)}`}>
          {current.fixtures.map((fixture) => (
            <FixtureEditor key={fixture.id} fixture={fixture} onSave={save} />
          ))}
        </Card>
      )}

      <Card title="Season data">
        <p className="small muted" style={{ marginTop: 0 }}>
          Load a generated sample season for testing. Live Premier League fixtures come from the
          football-data.org provider instead — see the README.
        </p>
        <button className="btn-ghost" type="button" onClick={async () => {
          if (!window.confirm('Seed sample fixtures? Existing fixtures are kept unless you reset.')) return;
          try {
            const result = await api.post('/api/admin/seasons/seed', { reset: false, backfillResults: false });
            setToast(`Seeded ${result.seasonName}: ${result.fixturesCreated} new fixtures`);
            seasons.reload();
            weeks.reload();
          } catch (seedError) {
            setError(seedError.message);
          }
        }}>Seed sample season</button>
      </Card>
    </div>
  );
}

function FixtureEditor({ fixture, onSave }) {
  const [home, setHome] = useState(fixture.home_score ?? '');
  const [away, setAway] = useState(fixture.away_score ?? '');
  const [status, setStatus] = useState(fixture.status);

  return (
    <div className="fixture">
      <div className="tiny muted">{formatShort(fixture.kickoff)}</div>
      <div className="row">
        <span className="grow small">{fixture.home_name}</span>
        <input style={{ width: 56 }} inputMode="numeric" value={home} onChange={(event) => setHome(event.target.value)} />
        <input style={{ width: 56 }} inputMode="numeric" value={away} onChange={(event) => setAway(event.target.value)} />
        <span className="grow small" style={{ textAlign: 'right' }}>{fixture.away_name}</span>
      </div>
      <div className="row">
        <select className="grow" value={status} onChange={(event) => setStatus(event.target.value)}>
          {['scheduled', 'live', 'finished', 'postponed', 'abandoned'].map((option) => (
            <option key={option} value={option}>{option}</option>
          ))}
        </select>
        <button className="btn-sm btn-ghost" type="button" onClick={onSave(fixture, {
          homeScore: home === '' ? null : Number(home),
          awayScore: away === '' ? null : Number(away),
          status,
        })}>Save</button>
      </div>
    </div>
  );
}

/** Cross-check every league on the platform in one place. */
function ChecksSection() {
  const { data, loading, error, reload } = useAsync(() => api.get('/api/admin/verification'));
  if (loading) return <Spinner />;
  if (error) return <Alert tone="error">{error}</Alert>;

  return (
    <div className="stack">
      <Card title="Results double-check">
        <p className="small muted" style={{ marginTop: 0 }}>
          Every pick in every league recomputed from the fixture list and compared with what was
          recorded. Nothing is changed automatically; fix the score under Results, then recompute the
          league.
        </p>
        {data.failing === 0
          ? <Alert tone="ok">All {data.leagues.length} league{data.leagues.length === 1 ? '' : 's'} agree with the fixtures.</Alert>
          : <Alert tone="error">{data.failing} league{data.failing === 1 ? '' : 's'} need attention.</Alert>}
        <button className="btn-ghost btn-sm" type="button" style={{ marginTop: 10 }} onClick={reload}>
          Run again
        </button>
      </Card>

      {data.leagues.map((league) => (
        <Card key={league.leagueId} title={league.leagueName}>
          <div className="spread">
            <span className="small muted">
              {league.picksChecked} pick{league.picksChecked === 1 ? '' : 's'} · {league.entriesChecked} entrants ·{' '}
              {league.roundsSettled} settled round{league.roundsSettled === 1 ? '' : 's'}
            </span>
            <span className={`badge ${league.ok ? 'badge-in' : 'badge-out'}`}>
              {league.ok ? 'Agrees' : `${league.errors} wrong`}
            </span>
          </div>
          {league.issues.length > 0 && (
            <div className="list" style={{ marginTop: 10 }}>
              {league.issues.map((issue, index) => (
                <div className="list-item" key={index}>
                  <span className={`badge ${issue.severity === 'error' ? 'badge-out' : 'badge-warn'}`}>
                    {issue.severity === 'error' ? 'Wrong' : 'Check'}
                  </span>
                  <div className="grow">
                    <div className="small strong">
                      {issue.entryName ?? 'League'}{issue.round ? ` · round ${issue.round}` : ''}
                    </div>
                    <div className="tiny muted">{issue.detail}</div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      ))}
    </div>
  );
}

function NotificationsSection({ setToast, setError }) {
  const { data, loading, reload } = useAsync(() => api.get('/api/admin/settings'));
  const [draft, setDraft] = useState(null);

  useEffect(() => { if (data) setDraft(data.notifications); }, [data]);
  if (loading || !draft) return <Spinner />;

  const save = async () => {
    setError('');
    try {
      await api.put('/api/admin/settings/notifications', {
        enabled: draft.enabled,
        reminderOffsetsMinutes: draft.reminderOffsetsMinutes,
        finalCallOffsetMinutes: draft.finalCallOffsetMinutes,
        resultNotices: draft.resultNotices,
        channels: draft.channels,
      });
      setToast('Notification settings saved');
      reload();
    } catch (saveError) {
      setError(saveError.message);
    }
  };

  return (
    <div className="stack">
      <Card title="When players are reminded">
        <p className="small muted" style={{ marginTop: 0 }}>
          Minutes before each deadline. Players who have not picked get every reminder; the final call
          goes to everyone.
        </p>
        <label className="field">
          Reminder offsets (minutes, comma separated)
          <input
            value={draft.reminderOffsetsMinutes.join(', ')}
            onChange={(event) => setDraft({
              ...draft,
              reminderOffsetsMinutes: event.target.value.split(',')
                .map((value) => Number(value.trim())).filter((value) => Number.isFinite(value) && value > 0),
            })}
          />
        </label>
        <div className="tiny dim" style={{ marginTop: -4, marginBottom: 10 }}>
          {draft.reminderOffsetsMinutes.map((minutes) => describeOffset(minutes)).join(' · ') || 'none'}
        </div>
        <label className="field">
          Final call to everyone (minutes before, blank for none)
          <input
            value={draft.finalCallOffsetMinutes ?? ''}
            onChange={(event) => setDraft({
              ...draft,
              finalCallOffsetMinutes: event.target.value === '' ? null : Number(event.target.value),
            })}
          />
        </label>

        <div className="stack" style={{ marginTop: 12 }}>
          <label className="checkbox">
            <input type="checkbox" checked={draft.enabled} onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })} />
            <span>Send deadline reminders</span>
          </label>
          <label className="checkbox">
            <input type="checkbox" checked={draft.resultNotices} onChange={(event) => setDraft({ ...draft, resultNotices: event.target.checked })} />
            <span>Tell players when they are through or out</span>
          </label>
          <label className="checkbox">
            <input type="checkbox" checked={draft.channels.email}
              onChange={(event) => setDraft({ ...draft, channels: { ...draft.channels, email: event.target.checked } })} />
            <span>Email channel enabled platform-wide</span>
          </label>
          <label className="checkbox">
            <input type="checkbox" checked={draft.channels.sms}
              onChange={(event) => setDraft({ ...draft, channels: { ...draft.channels, sms: event.target.checked } })} />
            <span>SMS channel enabled platform-wide</span>
          </label>
        </div>

        <div className="row" style={{ marginTop: 14 }}>
          <button className="btn-primary" type="button" onClick={save}>Save settings</button>
          <button className="btn-ghost" type="button" onClick={async () => {
            const result = await api.post('/api/admin/notifications/run');
            setToast(`Queued ${result.queued}, sent ${result.sent}`);
          }}>Run now</button>
        </div>
      </Card>

      <OutboxCard />
    </div>
  );
}

function describeOffset(minutes) {
  if (minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

function OutboxCard() {
  const { data, loading } = useAsync(() => api.get('/api/admin/notifications'));
  if (loading) return <Spinner />;
  return (
    <Card title="Recent messages">
      {data.notifications.length === 0 && <Empty>Nothing sent yet.</Empty>}
      <div className="table-wrap" style={{ maxHeight: 420, overflowY: 'auto' }}>
        <table>
          <thead><tr><th>When</th><th>To</th><th>Channel</th><th>Kind</th><th>Status</th></tr></thead>
          <tbody>
            {data.notifications.slice(0, 40).map((notification) => (
              <tr key={notification.id}>
                <td className="muted">{formatShort(notification.scheduled_for)}</td>
                <td>{notification.display_name}</td>
                <td>{notification.channel}</td>
                <td className="muted">{notification.kind}</td>
                <td>
                  <span className={`badge ${notification.status === 'sent' ? 'badge-in' : notification.status === 'failed' ? 'badge-out' : 'badge-pending'}`}>
                    {notification.status}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function SecuritySection({ setToast, setError }) {
  const [codes, setCodes] = useState(null);

  return (
    <div className="stack">
      <Card title="Super admin recovery">
        <p className="small muted" style={{ marginTop: 0 }}>
          Three ways back in, in order of preference:
        </p>
        <ol className="small muted" style={{ paddingLeft: 20, marginTop: 0 }}>
          <li>Your long passphrase plus your authenticator app.</li>
          <li>A one-time recovery code — signs you in, clears the second factor and forces a new passphrase.</li>
          <li>
            Shell access to the server: <span className="mono">npm run superadmin:reset</span>. This one
            cannot be phished, and is the reason no email-based reset exists for this account.
          </li>
        </ol>
        <button className="btn-ghost" type="button" onClick={async () => {
          if (!window.confirm('Generate ten new recovery codes? Any unused old codes stop working.')) return;
          try {
            const result = await api.post('/api/admin/recovery-codes');
            setCodes(result.codes);
            setToast('New recovery codes generated');
          } catch (generateError) {
            setError(generateError.message);
          }
        }}>Generate new recovery codes</button>

        {codes && (
          <>
            <Alert tone="warn">
              Shown once. Print them or put them in a password manager now.
            </Alert>
            <div className="grid-2" style={{ marginTop: 10 }}>
              {codes.map((code) => <div key={code} className="code-box" style={{ fontSize: '1rem' }}>{code}</div>)}
            </div>
          </>
        )}
      </Card>
    </div>
  );
}

function AuditSection() {
  const { data, loading } = useAsync(() => api.get('/api/admin/audit?limit=200'));
  if (loading) return <Spinner />;
  return (
    <Card title="Audit log">
      <div className="table-wrap" style={{ maxHeight: 520, overflowY: 'auto' }}>
        <table>
          <thead><tr><th>When</th><th>Who</th><th>Action</th><th>Target</th></tr></thead>
          <tbody>
            {data.entries.map((entry) => (
              <tr key={entry.id}>
                <td className="muted">{formatShort(entry.created_at)}</td>
                <td>{entry.display_name ?? <span className="dim">system</span>}</td>
                <td className="mono tiny">{entry.action}</td>
                <td className="muted tiny">{entry.entity}{entry.entity_id ? ` #${entry.entity_id}` : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
