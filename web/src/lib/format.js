export function formatDateTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-GB', {
    weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  });
}

export function formatShort(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-GB', {
    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  });
}

/** "2d 04h 11m" / "58m 12s" — used for the deadline countdown. */
export function countdown(iso) {
  if (!iso) return null;
  const remaining = new Date(iso).getTime() - Date.now();
  if (remaining <= 0) return 'Closed';
  const seconds = Math.floor(remaining / 1000);
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${String(hours).padStart(2, '0')}h ${String(minutes).padStart(2, '0')}m`;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`;
  return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`;
}

export const OUTCOME_LABEL = {
  pending: 'To play',
  win: 'Won',
  draw: 'Drew',
  loss: 'Lost',
  void: 'No result',
};

export const ELIMINATION_LABEL = {
  loss: 'pick lost',
  draw: 'pick drew',
  void: 'fixture void',
  no_pick: 'no pick made',
  admin: 'set by admin',
};
