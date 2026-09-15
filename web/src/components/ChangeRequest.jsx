import { useState } from 'react';
import { api } from '../api.js';
import { Alert, Card, Empty, Spinner, useAsync } from './ui.jsx';
import { formatShort } from '../lib/format.js';

/**
 * A launched league is frozen to its own admin, and there is no override —
 * entrants signed up to the rules as they stood. This is the way through:
 * ask, and every platform admin is emailed straight away.
 */
export default function ChangeRequest({ leagueId, league, setToast }) {
  const { data, loading, error, reload } = useAsync(
    () => api.get(`/api/leagues/${leagueId}/change-requests`), [leagueId],
  );
  const [message, setMessage] = useState('');
  const [sendError, setSendError] = useState('');
  const [busy, setBusy] = useState(false);

  const requests = data?.requests ?? [];
  const open = requests.filter((request) => request.status === 'open');

  async function send(event) {
    event.preventDefault();
    setBusy(true);
    setSendError('');
    try {
      const result = await api.post(`/api/leagues/${leagueId}/change-request`, { message });
      setMessage('');
      setToast?.(result.notified === 1
        ? 'Sent to the platform admin'
        : `Sent to ${result.notified} platform admins`);
      reload();
    } catch (error_) {
      setSendError(error_.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="Ask for a change">
      <p className="small muted" style={{ marginTop: 0 }}>
        The title, colours, crest and rules are fixed now your league is live — entrants signed up
        to them as they stand, so you cannot change them yourself and neither can anyone else
        pretending to be you. Describe what needs to change and the platform admin is emailed
        straight away. They will either make the change or reopen the setup for you.
      </p>

      {open.length > 0 && (
        <Alert tone="info">
          You have {open.length === 1 ? 'a request' : `${open.length} requests`} waiting for an
          answer. You will be emailed either way.
        </Alert>
      )}

      <form className="stack" onSubmit={send}>
        <label className="field">
          What needs to change, and why?
          <textarea
            id="change-request-message"
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            placeholder="The start gameweek is wrong — it should be 7, not 5. Nobody has picked yet."
            minLength={10}
            required
          />
        </label>
        <Alert tone="error">{sendError}</Alert>
        <button className="btn-primary" type="submit" disabled={busy || message.trim().length < 10}>
          {busy ? 'Sending…' : 'Send to the platform admin'}
        </button>
      </form>

      <div className="announce-log">
        <div className="announce-head">
          <span className="announce-title">Your requests</span>
          <button className="btn-ghost btn-sm" type="button" onClick={reload}>Refresh</button>
        </div>
        {loading && <Spinner />}
        <Alert tone="error">{error}</Alert>
        {!loading && requests.length === 0 && <Empty>You have not asked for anything yet.</Empty>}
        <div className="list">
          {requests.map((request) => (
            <div key={request.id} className="list-item" style={{ alignItems: 'flex-start' }}>
              <div className="grow">
                <span className={`badge ${request.status === 'open' ? 'badge-pending'
                  : request.status === 'resolved' ? 'badge-in' : 'badge-out'}`}>
                  {request.status === 'open' ? 'Waiting'
                    : request.status === 'resolved' ? 'Done' : 'Declined'}
                </span>
                <div className="small" style={{ marginTop: 4 }}>{request.message}</div>
                <div className="tiny dim">
                  Asked {formatShort(request.createdAt)}
                  {request.resolvedAt && ` · answered by ${request.resolvedByName} ${formatShort(request.resolvedAt)}`}
                </div>
                {request.outcome && <div className="tiny muted" style={{ marginTop: 4 }}>{request.outcome}</div>}
              </div>
            </div>
          ))}
        </div>
      </div>
    </Card>
  );
}
