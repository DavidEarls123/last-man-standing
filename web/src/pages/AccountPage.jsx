import { useState } from 'react';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { Alert, Card, Toast } from '../components/ui.jsx';

export default function AccountPage() {
  const { user, refresh } = useAuth();
  const [profile, setProfile] = useState({
    displayName: user.displayName ?? '',
    email: user.email ?? '',
    phone: user.phone ?? '',
    notifyEmail: user.notifyEmail,
    notifySms: user.notifySms,
  });
  const [passwords, setPasswords] = useState({ current: '', password: '' });
  const [totp, setTotp] = useState(null);
  const [totpCode, setTotpCode] = useState('');
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');

  const run = (action) => async (event) => {
    event?.preventDefault();
    setError('');
    try {
      await action();
      await refresh();
    } catch (actionError) {
      setError(actionError.message);
    }
  };

  return (
    <div className="stack">
      <h1>Account</h1>
      <Alert tone="error">{error}</Alert>

      <Card title="Your details">
        <form className="stack" onSubmit={run(async () => {
          await api.patch('/api/auth/me', {
            displayName: profile.displayName,
            email: profile.email || null,
            phone: profile.phone || null,
            notifyEmail: profile.notifyEmail,
            notifySms: profile.notifySms,
          });
          setToast('Details saved');
        })}>
          <label className="field">
            Name
            <input value={profile.displayName} onChange={(event) => setProfile({ ...profile, displayName: event.target.value })} />
          </label>
          <label className="field">
            Email address
            <input type="email" value={profile.email} onChange={(event) => setProfile({ ...profile, email: event.target.value })} />
          </label>
          <label className="field">
            Mobile number
            <input value={profile.phone} onChange={(event) => setProfile({ ...profile, phone: event.target.value })} placeholder="07700 900000" />
          </label>
          <button className="btn-primary" type="submit">Save details</button>
        </form>
      </Card>

      <Card title="Notifications">
        <p className="small muted" style={{ marginTop: 0 }}>
          Deadline reminders and results. How far ahead reminders go out is set by the platform admin.
        </p>
        <div className="stack">
          <label className="checkbox">
            <input
              type="checkbox" checked={profile.notifyEmail}
              onChange={(event) => setProfile({ ...profile, notifyEmail: event.target.checked })}
            />
            <span>Email me{user.email ? ` at ${user.email}` : ' (add an email address above)'}</span>
          </label>
          <label className="checkbox">
            <input
              type="checkbox" checked={profile.notifySms}
              onChange={(event) => setProfile({ ...profile, notifySms: event.target.checked })}
            />
            <span>Text me{user.phone ? ` on ${user.phone}` : ' (add a mobile number above)'}</span>
          </label>
          <button className="btn-ghost" type="button" onClick={run(async () => {
            await api.patch('/api/auth/me', { notifyEmail: profile.notifyEmail, notifySms: profile.notifySms });
            setToast('Notification settings saved');
          })}>Save notification settings</button>
        </div>
      </Card>

      <Card title="Password">
        <form className="stack" onSubmit={run(async () => {
          await api.post('/api/auth/me/password', passwords);
          setPasswords({ current: '', password: '' });
          setToast('Password changed');
        })}>
          <label className="field">
            Current password
            <input type="password" value={passwords.current} autoComplete="current-password"
              onChange={(event) => setPasswords({ ...passwords, current: event.target.value })} required />
          </label>
          <label className="field">
            New password
            <input type="password" value={passwords.password} autoComplete="new-password"
              onChange={(event) => setPasswords({ ...passwords, password: event.target.value })} required />
          </label>
          <button className="btn-primary" type="submit">Change password</button>
        </form>
      </Card>

      <Card title="Two-factor authentication">
        {user.totpEnabled ? (
          <>
            <Alert tone="ok">Two-factor is on for this account.</Alert>
            {!user.isSuperAdmin && (
              <button className="btn-danger btn-sm" style={{ marginTop: 10 }} type="button" onClick={run(async () => {
                const password = window.prompt('Confirm your password to turn off two-factor');
                if (!password) return;
                await api.post('/api/auth/me/totp/disable', { password });
                setToast('Two-factor turned off');
              })}>Turn off</button>
            )}
          </>
        ) : (
          <div className="stack">
            {user.isSuperAdmin && (
              <Alert tone="warn">
                As the platform super admin you should have two-factor switched on.
              </Alert>
            )}
            {!totp ? (
              <button className="btn-primary" type="button" onClick={run(async () => {
                setTotp(await api.post('/api/auth/me/totp/setup'));
              })}>Set up authenticator app</button>
            ) : (
              <>
                <p className="small muted" style={{ margin: 0 }}>
                  Add this secret to your authenticator app, then enter the code it shows.
                </p>
                <div className="code-box">{totp.secret}</div>
                <label className="field">
                  6-digit code
                  <input className="mono" inputMode="numeric" value={totpCode} onChange={(event) => setTotpCode(event.target.value)} />
                </label>
                <button className="btn-primary" type="button" onClick={run(async () => {
                  await api.post('/api/auth/me/totp/enable', { code: totpCode });
                  setTotp(null);
                  setTotpCode('');
                  setToast('Two-factor is on');
                })}>Confirm and turn on</button>
              </>
            )}
          </div>
        )}
      </Card>

      <Toast message={toast} onDone={() => setToast('')} />
    </div>
  );
}
