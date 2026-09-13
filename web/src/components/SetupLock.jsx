import { useState } from 'react';
import { api } from '../api.js';
import { Alert, Card } from './ui.jsx';
import { formatDateTime } from '../lib/format.js';

/**
 * Locking is what turns a draft league into the one people are playing: after
 * it, the settings the entrants signed up to cannot move under them.
 */
export default function SetupLock({ league, onChange, setToast }) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const isSuperAdmin = league.role === 'super_admin';
  const startedLock = league.configLockReason === 'competition_started';

  const act = (action) => async () => {
    setBusy(true);
    setError('');
    try {
      await action();
      await onChange?.();
    } catch (actionError) {
      setError(actionError.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="Setup lock">
      {league.configLocked ? (
        <Alert tone="ok">
          {startedLock
            ? 'Locked because the competition has kicked off.'
            : `Locked${league.configLockedAt ? ` on ${formatDateTime(league.configLockedAt)}` : ''}.`}
          {' '}The look and the rules are fixed for your entrants.
        </Alert>
      ) : (
        <p className="small muted" style={{ marginTop: 0 }}>
          Once you are happy with the title, colours, crest and rules, lock them in. Entrants then know
          the competition cannot change shape underneath them. It locks by itself at the first kick off.
        </p>
      )}

      <Alert tone="error">{error}</Alert>

      <div className="row" style={{ marginTop: 10 }}>
        {!league.configLocked && (
          <button className="btn-primary" type="button" disabled={busy} onClick={act(async () => {
            if (!window.confirm('Lock the setup? Only the platform admin can reopen it.')) return;
            await api.post(`/api/leagues/${league.id}/lock`);
            setToast?.('Setup locked');
          })}>Lock setup</button>
        )}

        {league.configLocked && isSuperAdmin && !startedLock && (
          <button className="btn-ghost" type="button" disabled={busy} onClick={act(async () => {
            const reason = window.prompt('Why is this league being reopened?');
            if (!reason) return;
            await api.post(`/api/leagues/${league.id}/unlock`, { reason });
            setToast?.('Setup reopened for the league admin');
          })}>Reopen setup</button>
        )}
      </div>

      {league.configLocked && startedLock && isSuperAdmin && (
        <p className="tiny dim" style={{ marginBottom: 0, marginTop: 10 }}>
          A competition that has started stays locked to its admin whatever happens — make any changes
          yourself in the form above.
        </p>
      )}
    </Card>
  );
}
