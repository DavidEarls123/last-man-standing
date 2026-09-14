import { useState } from 'react';
import { api } from '../api.js';
import { Alert, Card } from './ui.jsx';
import { formatDateTime } from '../lib/format.js';

/**
 * Launching is what turns a draft into a league. It does two things at once:
 * it freezes the settings entrants will be signing up to, and it issues the
 * invite. Before it there is nothing to share; after it, changes go through
 * the platform admin.
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
    <Card title={league.launched ? 'Your league is live' : 'Confirm and launch'}>
      {league.launched ? (
        <Alert tone="ok">
          Launched{league.launchedAt ? ` on ${formatDateTime(league.launchedAt)}` : ''}. The title,
          colours, crest and rules are fixed for your entrants
          {startedLock ? ', and the competition has kicked off' : ''}.
          {' '}If something genuinely has to change, contact the platform admin.
        </Alert>
      ) : (
        <>
          <p className="small muted" style={{ marginTop: 0 }}>
            Go through the setup above until you are happy with it, then launch. Two things happen
            at once:
          </p>
          <ul className="small muted" style={{ marginTop: 6 }}>
            <li>Your invite link and join code are issued, so you can start inviting players.</li>
            <li>
              The title, colours, crest and rules stop being editable — entrants know the
              competition cannot change shape underneath them. After that, changes go through the
              platform admin.
            </li>
          </ul>
          <p className="small muted" style={{ marginTop: 6, marginBottom: 0 }}>
            Nobody can join until you do this.
          </p>
        </>
      )}

      <Alert tone="error">{error}</Alert>

      <div className="row" style={{ marginTop: 12 }}>
        {!league.launched && (
          <button className="btn-primary grow" type="button" disabled={busy} onClick={act(async () => {
            const confirmed = window.confirm(
              `Launch "${league.name}"?\n\n`
              + 'Your invite link is issued and the setup is fixed. Only the platform admin can '
              + 'change it afterwards.',
            );
            if (!confirmed) return;
            await api.post(`/api/leagues/${league.id}/lock`);
            setToast?.('League launched — your invite link is ready');
          })}>{busy ? 'Launching…' : 'Confirm and launch league'}</button>
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
