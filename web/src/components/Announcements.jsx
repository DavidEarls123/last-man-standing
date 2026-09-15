import { useState } from 'react';
import { api } from '../api.js';
import { Alert, Card, Empty, Spinner, useAsync } from './ui.jsx';
import { formatShort } from '../lib/format.js';

/**
 * Everything this league has said to its players, in one place.
 *
 * Two kinds sit side by side and are labelled apart: the announcements an admin
 * typed, and the messages the league sent by itself — deadline reminders,
 * results, a club picked for somebody who forgot. An admin needs both, because
 * "have they been told?" is the same question either way.
 */
export default function Announcements({ leagueId, league, setToast }) {
  const { data, loading, error, reload } = useAsync(
    () => api.get(`/api/leagues/${leagueId}/announcements`), [leagueId],
  );
  const [draft, setDraft] = useState({ subject: '', message: '' });
  const [filter, setFilter] = useState('all');
  const [openBatch, setOpenBatch] = useState(null);
  const [openMessage, setOpenMessage] = useState(null);
  const [sendError, setSendError] = useState('');
  const [busy, setBusy] = useState(false);

  const batches = data?.batches ?? [];
  const manualCount = batches.filter((batch) => batch.manual).length;
  const autoCount = batches.length - manualCount;
  const shown = batches.filter((batch) => (
    filter === 'all' || (filter === 'manual' ? batch.manual : !batch.manual)
  ));

  async function send(event) {
    event.preventDefault();
    setBusy(true);
    setSendError('');
    try {
      const result = await api.post(`/api/leagues/${leagueId}/announce`, draft);
      setDraft({ subject: '', message: '' });
      setToast?.(`Announcement queued to ${result.queued} player${result.queued === 1 ? '' : 's'}`);
      reload();
    } catch (error_) {
      setSendError(error_.message);
    } finally {
      setBusy(false);
    }
  }

  if (!league.launched) {
    return (
      <Card title="Announcements">
        <Alert tone="info">
          Once you launch the league this is where you message your players, and where every
          message the league sends on its own is logged.
        </Alert>
      </Card>
    );
  }

  return (
    <Card title="Announcements">
      {league.smsEnabled === false && (
        <Alert tone="info">
          This league is set to email only — the platform admin controls whether it can send texts.
        </Alert>
      )}

      <form className="stack" onSubmit={send}>
        <label className="field">
          Subject
          <input
            id="announce-subject"
            value={draft.subject}
            onChange={(event) => setDraft({ ...draft, subject: event.target.value })}
            placeholder="Deadline moved to Friday"
            required
          />
        </label>
        <label className="field">
          Message
          <textarea
            id="announce-message"
            value={draft.message}
            onChange={(event) => setDraft({ ...draft, message: event.target.value })}
            required
          />
        </label>
        <Alert tone="error">{sendError}</Alert>
        <button className="btn-primary" type="submit" disabled={busy}>
          {busy ? 'Sending…' : 'Send to all players'}
        </button>
      </form>

      <div className="announce-log">
        <div className="announce-head">
          <span className="announce-title">Sent so far</span>
          <div className="segmented announce-filter">
            {[
              ['all', `All ${batches.length}`],
              ['manual', `Yours ${manualCount}`],
              ['auto', `Automatic ${autoCount}`],
            ].map(([key, label]) => (
              <button
                key={key}
                type="button"
                className={filter === key ? 'active' : ''}
                onClick={() => setFilter(key)}
              >{label}</button>
            ))}
          </div>
          <button className="btn-ghost btn-sm" type="button" onClick={reload}>Refresh</button>
        </div>

        {loading && <Spinner />}
        <Alert tone="error">{error}</Alert>
        {!loading && shown.length === 0 && (
          <Empty>
            {filter === 'manual'
              ? 'You have not sent an announcement yet.'
              : filter === 'auto'
                ? 'The league has not sent anything on its own yet.'
                : 'Nothing has been sent in this league yet.'}
          </Empty>
        )}

        <div className="list">
          {shown.map((batch) => {
            const expanded = openBatch === batch.key;
            return (
              <div key={batch.key} className="list-item" style={{ alignItems: 'flex-start' }}>
                <button
                  type="button"
                  className="batch-head"
                  aria-expanded={expanded}
                  onClick={() => { setOpenBatch(expanded ? null : batch.key); setOpenMessage(null); }}
                >
                  <span className="row-tight" style={{ flexWrap: 'wrap' }}>
                    <span className={`badge ${batch.manual ? 'badge-admin' : 'badge-pending'}`}>
                      {batch.manual ? 'From you' : 'Automatic'}
                    </span>
                    <span className="small strong">{batch.label}</span>
                    {batch.round != null && <span className="tiny muted">round {batch.round}</span>}
                  </span>
                  <span className="small" style={{ display: 'block', marginTop: 3 }}>
                    {batch.subject}
                  </span>
                  <span className="tiny dim">
                    {formatShort(batch.scheduledFor)} · {batch.counts.total}{' '}
                    player{batch.counts.total === 1 ? '' : 's'}
                    {batch.counts.failed > 0 && ` · ${batch.counts.failed} failed`}
                  </span>
                </button>

                {expanded && (
                  <div className="stack" style={{ flex: '1 1 100%', gap: 6, marginTop: 8 }}>
                    {batch.recipients.map((recipient) => (
                      <div key={recipient.id}>
                        <button
                          type="button"
                          className="batch-recipient"
                          aria-expanded={openMessage === recipient.id}
                          onClick={() => setOpenMessage(openMessage === recipient.id ? null : recipient.id)}
                        >
                          <span className="grow">{recipient.name}</span>
                          <span className="tiny dim">{recipient.channel} · {recipient.status}</span>
                        </button>
                        {openMessage === recipient.id && (
                          <pre className="message-body">{recipient.subject}{'\n\n'}{recipient.body}</pre>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <p className="tiny dim" style={{ marginBottom: 0 }}>
          <strong>From you</strong> is something you typed. <strong>Automatic</strong> is the league
          itself — deadline reminders, results, a club handed to somebody who missed the deadline.
          Open one to see who it went to and read it.
        </p>
      </div>
    </Card>
  );
}
