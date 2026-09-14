import { useState } from 'react';
import { api } from '../api.js';
import { useLeague } from '../league.jsx';
import { Alert, Card, Empty, Spinner, Toast, useAsync } from '../components/ui.jsx';
import { formatShort } from '../lib/format.js';
import EntryOverride from '../components/EntryOverride.jsx';
import LeagueBranding from '../components/LeagueBranding.jsx';
import SetupLock from '../components/SetupLock.jsx';
import VerificationCard from '../components/VerificationCard.jsx';

export default function LeagueAdminPage() {
  const league = useLeague();
  const leagueId = league.leagueId;
  const { data, loading, error, reload } = useAsync(() => api.get(`/api/leagues/${leagueId}/members`), [leagueId]);
  const [form, setForm] = useState({ displayName: '', email: '', phone: '' });
  const [announcement, setAnnouncement] = useState({ subject: '', message: '' });
  const [actionError, setActionError] = useState('');
  const [toast, setToast] = useState('');
  const [tempPassword, setTempPassword] = useState(null);

  const run = (action) => async (event) => {
    event?.preventDefault();
    setActionError('');
    try {
      await action();
      reload();
      await league.reload();
    } catch (runError) {
      setActionError(runError.message);
    }
  };

  if (loading) return <Spinner />;
  if (error) return <Alert tone="error">{error}</Alert>;

  // The super admin can still add people after the deadline; a league admin cannot.
  const entriesClosed = league.league.entryClosed && league.league.role !== 'super_admin';

  return (
    <div className="stack">
      <div>
        <h1>Manage {league.league.name}</h1>
        <p className="muted small" style={{ marginTop: 4 }}>
          Set the look, add players, share the join link and keep the league tidy.
        </p>
      </div>

      <Alert tone="error">{actionError}</Alert>

      <LeagueBranding league={league.league} onSaved={() => league.reload()} setToast={setToast} />

      <SetupLock league={league.league} onChange={() => league.reload()} setToast={setToast} />

      <VerificationCard leagueId={leagueId} setToast={setToast} />

      <Card title="Invite players">
        <div className="code-box">{data.joinCode}</div>
        <div className="row" style={{ marginTop: 10 }}>
          <button className="btn-ghost btn-sm grow" type="button" onClick={() => {
            navigator.clipboard?.writeText(data.joinUrl);
            setToast('Invite link copied');
          }}>Copy invite link</button>
          <button className="btn-ghost btn-sm" type="button" onClick={run(async () => {
            await api.post(`/api/leagues/${leagueId}/join-code`);
            setToast('New code generated — the old one no longer works');
          })}>New code</button>
        </div>
        <p className="tiny dim mono" style={{ marginTop: 8, marginBottom: 0, wordBreak: 'break-all' }}>
          {data.joinUrl}
        </p>
      </Card>

      <Card title="Add a player">
        {entriesClosed && (
          <Alert tone="warn">
            Entries closed at the first kick off, so new players can only be added by the platform admin.
          </Alert>
        )}
        <form className="stack" onSubmit={run(async () => {
          const result = await api.post(`/api/leagues/${leagueId}/members`, {
            displayName: form.displayName,
            email: form.email || undefined,
            phone: form.phone || undefined,
          });
          setForm({ displayName: '', email: '', phone: '' });
          setTempPassword(result.temporaryPassword ? { name: result.name, password: result.temporaryPassword } : null);
          setToast(`${result.name} added`);
        })}>
          <label className="field">
            Name
            <input value={form.displayName} onChange={(event) => setForm({ ...form, displayName: event.target.value })} required />
          </label>
          <div className="grid-2">
            <label className="field">
              Email
              <input type="email" value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} />
            </label>
            <label className="field">
              Mobile
              <input value={form.phone} onChange={(event) => setForm({ ...form, phone: event.target.value })} />
            </label>
          </div>
          <button className="btn-primary" type="submit" disabled={entriesClosed}>Add player</button>
        </form>
        {tempPassword && (
          <Alert tone="ok">
            Account created for {tempPassword.name}. Temporary password:{' '}
            <strong className="mono">{tempPassword.password}</strong> — it has also been sent to them.
          </Alert>
        )}
      </Card>

      <Card title={`Players (${data.members.length})`}>
        {data.members.length === 0 && <Empty>Nobody has joined yet.</Empty>}
        <div className="list">
          {data.members.map((member) => (
            <div key={member.entryId} className="list-item">
              <div className="grow">
                <div className="strong">{member.name}</div>
                <div className="tiny muted">
                  {member.email || member.phone} · joined {formatShort(member.joinedAt)}
                  {member.reinstatedReason && ` · put back in: ${member.reinstatedReason}`}
                </div>
              </div>
              <span className={`badge ${member.status === 'active' ? 'badge-in' : 'badge-out'}`}>
                {member.status === 'active' ? 'In' : member.status === 'withdrawn' ? 'Withdrawn' : `Out R${member.eliminatedRound}`}
              </span>
              <span className="row-tight">
                {member.status === 'eliminated' && (
                  <button className="btn-ghost btn-sm" type="button" onClick={run(async () => {
                    const reason = window.prompt(`Why is ${member.name} going back in?`);
                    if (!reason) return;
                    await api.post(`/api/leagues/${leagueId}/members/${member.entryId}/reinstate`, { reason });
                    setToast(`${member.name} is back in`);
                  })}>Put back in</button>
                )}
                <button className="btn-danger btn-sm" type="button" onClick={run(async () => {
                  if (!window.confirm(`Remove ${member.name} from this league?`)) return;
                  const result = await api.del(`/api/leagues/${leagueId}/members/${member.entryId}`);
                  setToast(result.action === 'withdrawn' ? `${member.name} withdrawn` : `${member.name} removed`);
                })}>Remove</button>
              </span>
            </div>
          ))}
        </div>
        <p className="tiny dim" style={{ marginTop: 10, marginBottom: 0 }}>
          Once the competition is under way, removing a player withdraws them so past rounds still add up.
          "Put back in" is there for the special cases — a pick that never saved, a fixture mix-up.
        </p>
      </Card>

      <Card title="Message everyone">
        {league.league.smsEnabled === false && (
          <Alert tone="info">
            This league is set to email only — the platform admin controls whether it can send
            texts.
          </Alert>
        )}
        <form className="stack" onSubmit={run(async () => {
          const result = await api.post(`/api/leagues/${leagueId}/announce`, announcement);
          setAnnouncement({ subject: '', message: '' });
          setToast(`Message queued to ${result.queued} recipient${result.queued === 1 ? '' : 's'}`);
        })}>
          <label className="field">
            Subject
            <input value={announcement.subject} onChange={(event) => setAnnouncement({ ...announcement, subject: event.target.value })} required />
          </label>
          <label className="field">
            Message
            <textarea value={announcement.message} onChange={(event) => setAnnouncement({ ...announcement, message: event.target.value })} required />
          </label>
          <button className="btn-ghost" type="submit">Send to all players</button>
        </form>
      </Card>


      {league.league.role === 'super_admin' && (
        <EntryOverride leagueId={leagueId} onChange={() => { reload(); league.reload(); }} />
      )}

      <Toast message={toast} onDone={() => setToast('')} />
    </div>
  );
}
