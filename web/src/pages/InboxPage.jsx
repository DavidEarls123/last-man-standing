import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Alert, Card, Empty, Spinner } from '../components/ui.jsx';
import { formatShort } from '../lib/format.js';
import { useInbox } from '../inbox.jsx';

/**
 * Everything the signed-in account has been sent. Opening one marks it read;
 * the badge in the bar above counts the rest.
 */
export default function InboxPage() {
  const { messages, unread, loaded, markRead } = useInbox();
  const [open, setOpen] = useState(null);
  const [filter, setFilter] = useState('all');

  const shown = messages.filter((message) => filter === 'all' || !message.read);

  function toggle(message) {
    const next = open === message.id ? null : message.id;
    setOpen(next);
    if (next && !message.read) markRead([message.id]);
  }

  if (!loaded) return <Spinner />;

  return (
    <div className="stack">
      <div>
        <h1>Your messages</h1>
        <p className="muted small" style={{ marginTop: 4 }}>
          Everything the league has sent you — deadline reminders, results, announcements.
        </p>
      </div>

      <Card title={`Inbox${unread ? ` · ${unread} unread` : ''}`}>
        <div className="row" style={{ marginBottom: 10 }}>
          <div className="segmented grow">
            {[['all', `All ${messages.length}`], ['unread', `Unread ${unread}`]].map(([key, label]) => (
              <button
                key={key}
                type="button"
                className={filter === key ? 'active' : ''}
                onClick={() => setFilter(key)}
              >{label}</button>
            ))}
          </div>
          {unread > 0 && (
            <button className="btn-ghost btn-sm" type="button" onClick={() => markRead()}>
              Mark all read
            </button>
          )}
        </div>

        {shown.length === 0 && (
          <Empty>
            {filter === 'unread' ? 'Nothing unread.' : 'Nothing has been sent to you yet.'}
          </Empty>
        )}

        <div className="list">
          {shown.map((message) => (
            <div key={message.id} className="list-item" style={{ alignItems: 'flex-start' }}>
              <button
                type="button"
                className="batch-head"
                aria-expanded={open === message.id}
                onClick={() => toggle(message)}
              >
                <span className="row-tight" style={{ flexWrap: 'wrap' }}>
                  {!message.read && <span className="unread-dot" aria-label="Unread" />}
                  <span className="badge badge-pending">{message.label}</span>
                  {message.leagueName && <span className="tiny muted">{message.leagueName}</span>}
                </span>
                <span className={`small${message.read ? '' : ' strong'}`} style={{ display: 'block', marginTop: 3 }}>
                  {message.subject}
                </span>
                <span className="tiny dim">
                  {formatShort(message.sentAt || message.scheduledFor)}
                  {' · '}{message.channels.join(' and ')}
                  {message.status !== 'sent' && ` · ${message.status}`}
                </span>
              </button>
              {open === message.id && (
                <div style={{ flex: '1 1 100%', marginTop: 8 }}>
                  <pre className="message-body">{message.body}</pre>
                  {message.leagueId && (
                    <Link className="btn-ghost btn-sm" to={`/leagues/${message.leagueId}`}>
                      Open {message.leagueName}
                    </Link>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      </Card>

      <Alert tone="info">
        While the platform has no mail server configured, this is the only place these messages
        exist — nothing is actually emailed or texted. Switch email on and these become copies of
        what arrived in your real inbox.
      </Alert>
    </div>
  );
}
