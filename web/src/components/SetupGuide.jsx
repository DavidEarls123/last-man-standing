import { useEffect, useRef } from 'react';
import { api } from '../api.js';

/**
 * What a league admin sees the first time they open a league handed to them.
 *
 * They arrive knowing only that someone said "you're running the pool". The
 * order matters and one step cannot be undone — launching freezes the setup —
 * so this says that before they get there rather than after. Dismissed once,
 * per league, and never shown again.
 */
const STEPS = [
  ['Make it yours', 'Give it a name, two colours and a crest. Your players see this, not Off The Bridle’s.'],
  ['Set the rules', 'Start gameweek, what a draw does, what happens to a postponed game, and what happens when somebody forgets. The i beside each one explains it.'],
  ['Confirm and launch', 'This issues your invite link and freezes the title, colours and rules — entrants need to know the competition cannot change shape under them. After it, changes go through the platform admin.'],
  ['Invite your players', 'Share the link or the join code. You can add people directly too.'],
  ['Keep them posted', 'Announcements is yours: deadline changes, results chat, anything. It also logs every message the league sends on its own.'],
];

export default function SetupGuide({ leagueId, leagueName, onClose }) {
  const button = useRef(null);

  useEffect(() => {
    button.current?.focus();
    const key = (event) => { if (event.key === 'Escape') dismiss(); };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  });

  async function dismiss() {
    // Closing locally even if the request fails: a guide that will not go away
    // because the network blipped is worse than one shown twice.
    try { await api.post(`/api/leagues/${leagueId}/guide-seen`); } catch { /* ignore */ }
    onClose();
  }

  return (
    <div className="modal-veil" role="presentation">
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="guide-title">
        <h2 id="guide-title" style={{ marginTop: 0 }}>You are running {leagueName}</h2>
        <p className="small muted">
          Nobody can join until you have set it up and launched it. Five things, in this order:
        </p>
        <ol className="guide-steps">
          {STEPS.map(([title, detail]) => (
            <li key={title}>
              <span className="strong">{title}</span>
              <span className="small muted" style={{ display: 'block' }}>{detail}</span>
            </li>
          ))}
        </ol>
        <button ref={button} className="btn-primary" type="button" onClick={dismiss} style={{ width: '100%' }}>
          Got it — let me set it up
        </button>
      </div>
    </div>
  );
}
