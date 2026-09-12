export const nowIso = () => new Date().toISOString();

export const isPast = (iso) => new Date(iso).getTime() <= Date.now();

export const minutesUntil = (iso) => Math.round((new Date(iso).getTime() - Date.now()) / 60000);

/** "2 days 4 hours", "35 minutes", "0 minutes" — used in notification copy. */
export function humaniseDuration(minutes) {
  const total = Math.max(0, Math.round(minutes));
  const days = Math.floor(total / 1440);
  const hours = Math.floor((total % 1440) / 60);
  const mins = total % 60;
  const parts = [];
  if (days) parts.push(`${days} day${days === 1 ? '' : 's'}`);
  if (hours) parts.push(`${hours} hour${hours === 1 ? '' : 's'}`);
  if (mins && !days) parts.push(`${mins} minute${mins === 1 ? '' : 's'}`);
  return parts.length ? parts.join(' ') : '0 minutes';
}

export function formatKickoff(iso) {
  return new Date(iso).toLocaleString('en-GB', {
    weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
    timeZone: 'Europe/London',
  });
}
