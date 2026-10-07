import { useEffect, useState } from 'react';
import { countdown } from '../lib/format.js';

export const Card = ({ title, action, children, className = '' }) => (
  <section className={`card ${className}`}>
    {(title || action) && (
      <div className="spread" style={{ marginBottom: 12 }}>
        {title && <div className="card-title" style={{ margin: 0 }}>{title}</div>}
        {action}
      </div>
    )}
    {children}
  </section>
);

export const Stat = ({ value, label, tone }) => (
  <div className="stat">
    <div className="stat-value" style={tone ? { color: `var(--${tone})` } : undefined}>{value}</div>
    <div className="stat-label">{label}</div>
  </div>
);

export const Bar = ({ pct, out = false }) => (
  <div className="bar" role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}>
    <div className={`bar-fill${out ? ' out' : ''}`} style={{ width: `${Math.max(0, Math.min(100, pct))}%` }} />
  </div>
);

export const Alert = ({ tone = 'info', children }) =>
  children ? <div className={`alert alert-${tone}`}>{children}</div> : null;

export const Spinner = () => <div className="spinner" aria-label="Loading" />;

export const Empty = ({ children }) => (
  <p className="muted small" style={{ margin: '6px 0' }}>{children}</p>
);

/** Ticking countdown to a deadline. */
export function Countdown({ deadline, className = '' }) {
  const [value, setValue] = useState(() => countdown(deadline));
  useEffect(() => {
    setValue(countdown(deadline));
    const timer = setInterval(() => setValue(countdown(deadline)), 1000);
    return () => clearInterval(timer);
  }, [deadline]);
  if (!deadline) return <span className={className}>—</span>;
  return <span className={`countdown ${className}`}>{value}</span>;
}

export function Toast({ message, onDone, ms = 3200 }) {
  useEffect(() => {
    if (!message) return undefined;
    const timer = setTimeout(onDone, ms);
    return () => clearTimeout(timer);
  }, [message, onDone, ms]);
  if (!message) return null;
  return <div className="toast">{message}</div>;
}

/**
 * Small hook for "load once, show a spinner, surface errors". A reload keeps
 * the previous data on screen, so refreshing after an action does not tear the
 * panel down underneath the user.
 */
export function useAsync(loader, deps = []) {
  const [state, setState] = useState({ loading: true, data: null, error: null });
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let live = true;
    setState((previous) => ({ ...previous, loading: true }));
    loader()
      .then((data) => live && setState({ loading: false, data, error: null }))
      .catch((error) => live && setState((previous) => ({ loading: false, data: previous.data, error: error.message })));
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);

  return {
    ...state,
    // Only the very first load should blank the screen.
    loading: state.loading && state.data === null,
    refreshing: state.loading,
    reload: () => setNonce((value) => value + 1),
  };
}

/**
 * A value worth copying — a one-time password, a join code, an invite link.
 * Shown in full as well as copyable, because clipboard access fails silently
 * in enough situations (an insecure origin, a locked-down browser) that a
 * button alone would leave someone with no way to get the thing.
 */
export function CopyButton({ value, label = 'Copy', className = 'btn-ghost btn-sm' }) {
  const [state, setState] = useState('idle');

  async function copy() {
    try {
      await navigator.clipboard.writeText(String(value));
      setState('done');
    } catch {
      setState('failed');
    }
    setTimeout(() => setState('idle'), 2000);
  }

  return (
    <button type="button" className={className} onClick={copy} aria-live="polite">
      {state === 'done' ? 'Copied' : state === 'failed' ? 'Select it yourself' : label}
    </button>
  );
}

/** A secret shown once, with the means to take it away. */
export function SecretValue({ label, value, note }) {
  return (
    <div className="secret">
      {label && <div className="tiny dim">{label}</div>}
      <div className="row-tight" style={{ marginTop: 3 }}>
        <code className="secret-value">{value}</code>
        <CopyButton value={value} />
      </div>
      {note && <div className="tiny dim" style={{ marginTop: 5 }}>{note}</div>}
    </div>
  );
}
