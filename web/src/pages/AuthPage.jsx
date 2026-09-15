import { useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { useAuth } from '../auth.jsx';
import { api } from '../api.js';
import { Alert, Card } from '../components/ui.jsx';
import Logo from '../components/Logo.jsx';
import GameMark from '../components/GameMark.jsx';
import { BRAND, GAMES } from '../lib/brand.js';
import { usePlatform } from '../platform.jsx';

const MODES = {
  signin: 'Sign in',
  register: 'Create account',
  forgot: 'Forgotten password',
  reset: 'Set a new password',
  recovery: 'Super admin recovery',
};

export default function AuthPage({ initialMode = 'signin' }) {
  const { code } = useParams();
  const [params] = useSearchParams();
  const resetToken = params.get('token');
  const { signIn, register } = useAuth();
  const platform = usePlatform();

  const [mode, setMode] = useState(resetToken ? 'reset' : initialMode);
  const [form, setForm] = useState({
    identifier: '', password: '', totp: '', displayName: '', email: '', phone: '',
    code: '', confirm: '',
  });
  const [needsTotp, setNeedsTotp] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  const update = (field) => (event) => setForm({ ...form, [field]: event.target.value });

  async function onSubmit(event) {
    event.preventDefault();
    setError('');
    setNotice('');
    setBusy(true);
    try {
      if (mode === 'signin') {
        await signIn({
          identifier: form.identifier,
          password: form.password,
          ...(form.totp ? { totp: form.totp } : {}),
        });
        if (code) window.location.assign(`/join/${code}`);
      } else if (mode === 'register') {
        if (!form.email && !form.phone) throw new Error('Give an email address or a mobile number');
        await register({
          displayName: form.displayName,
          email: form.email || undefined,
          phone: form.phone || undefined,
          password: form.password,
        });
        if (code) window.location.assign(`/join/${code}`);
      } else if (mode === 'forgot') {
        const result = await api.post('/api/auth/forgot', { identifier: form.identifier });
        setNotice(result.message);
      } else if (mode === 'reset') {
        if (form.password !== form.confirm) throw new Error('Those passwords do not match');
        await api.post('/api/auth/reset', { token: resetToken, password: form.password });
        setNotice('Password updated. You can sign in now.');
        setMode('signin');
      } else if (mode === 'recovery') {
        await api.post('/api/auth/recovery', {
          identifier: form.identifier, code: form.code, password: form.password,
        });
        window.location.assign('/');
      }
    } catch (submitError) {
      if (submitError.code === 'totp_required') {
        setNeedsTotp(true);
        setError('Enter the 6-digit code from your authenticator app.');
      } else {
        setError(submitError.message);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-shell">
      <div className="auth-inner">
        {/* Company, then the game under it, the same order as the bars inside.
            You are signing in to the company; the games are what it runs. */}
        <div className="auth-brand">
          <span className={`auth-mark mark-${platform.mark}`}>
            <Logo size={38} hole="var(--pitch-deep)" variant={platform.mark} />
          </span>
          <span className="auth-title">{platform.company}</span>
          <div className="auth-games">
            {GAMES.map((game) => (
              <span className="auth-game" key={game.key}>
                <GameMark game={game.key} size={19} hole="var(--pitch-deep)" />
                {game.name}
              </span>
            ))}
          </div>
          <span className="auth-tagline">
            {GAMES.length === 1 ? GAMES[0].blurb : 'One account for every game we run.'}
          </span>
        </div>

      <div className="auth-card stack">
        {code && (
          <Alert tone="info">
            You have been invited to a league with code <strong>{code}</strong>. Sign in or create an
            account and we will take you straight there.
          </Alert>
        )}

        <Card>
          <h1 style={{ marginBottom: 4 }}>{MODES[mode]}</h1>
          <p className="muted small" style={{ marginTop: 0 }}>
            {mode === 'register'
              ? 'One account, every game and every league you are invited to.'
              : mode === 'recovery'
                ? 'Use one of the one-time recovery codes issued when the platform was set up.'
                : 'Use the email address or mobile number you signed up with.'}
          </p>

          <form className="stack" onSubmit={onSubmit}>
            {mode === 'register' && (
              <>
                <label className="field">
                  Your name
                  <input value={form.displayName} onChange={update('displayName')} required minLength={2} autoComplete="name" />
                </label>
                <label className="field">
                  Email address
                  <input type="email" value={form.email} onChange={update('email')} autoComplete="email" placeholder="you@example.com" />
                </label>
                <label className="field">
                  Mobile number (optional)
                  <input value={form.phone} onChange={update('phone')} autoComplete="tel" placeholder="07700 900000" />
                </label>
              </>
            )}

            {mode !== 'register' && mode !== 'reset' && (
              <label className="field">
                Email or mobile
                <input value={form.identifier} onChange={update('identifier')} required autoComplete="username" />
              </label>
            )}

            {mode === 'recovery' && (
              <label className="field">
                Recovery code
                <input className="mono" value={form.code} onChange={update('code')} required placeholder="XXXXX-XXXXX" />
              </label>
            )}

            {mode !== 'forgot' && (
              <label className="field">
                {mode === 'reset' || mode === 'recovery' ? 'New password' : 'Password'}
                <input
                  type="password" value={form.password} onChange={update('password')} required
                  autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
                />
              </label>
            )}

            {mode === 'reset' && (
              <label className="field">
                Confirm password
                <input type="password" value={form.confirm} onChange={update('confirm')} required autoComplete="new-password" />
              </label>
            )}

            {mode === 'signin' && needsTotp && (
              <label className="field">
                Authenticator code
                <input className="mono" inputMode="numeric" value={form.totp} onChange={update('totp')} placeholder="123456" />
              </label>
            )}

            <Alert tone="error">{error}</Alert>
            <Alert tone="ok">{notice}</Alert>

            <button className="btn-primary btn-block" type="submit" disabled={busy}>
              {busy ? 'Working…' : MODES[mode]}
            </button>
          </form>
        </Card>

        <div className="row small" style={{ justifyContent: 'center' }}>
          {mode !== 'signin' && <button className="btn-ghost btn-sm" onClick={() => setMode('signin')}>Sign in</button>}
          {mode !== 'register' && <button className="btn-ghost btn-sm" onClick={() => setMode('register')}>Create account</button>}
          {mode !== 'forgot' && <button className="btn-ghost btn-sm" onClick={() => setMode('forgot')}>Forgot password</button>}
          {mode !== 'recovery' && <button className="btn-ghost btn-sm" onClick={() => setMode('recovery')}>Recovery code</button>}
        </div>

      </div>
      </div>
    </div>
  );
}
