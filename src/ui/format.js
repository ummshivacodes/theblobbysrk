// Human-readable timestamps for the ⚙ screen. `now` is a parameter so the function is testable
// without a clock.
export function fmtWhen(ts, now = new Date()) {
  if (!ts) return '';
  const d = new Date(ts);
  const sameDay = d.toDateString() === now.toDateString();
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).toLowerCase();
  if (sameDay) return `today · ${time}`;
  const yday = new Date(now);
  yday.setDate(now.getDate() - 1);
  if (d.toDateString() === yday.toDateString()) return `yesterday · ${time}`;
  return d.toLocaleDateString([], { day: 'numeric', month: 'short' });
}

// "2h ago"-style relative time, for the Notes screen ("edited 2h ago"). `now` is a parameter so it is
// testable without a clock. Past a week it is just the date (with the year only if it isn't this year).
export function fmtAgo(ts, now = Date.now()) {
  if (!Number.isFinite(ts) || ts <= 0) return '';
  const diff = Math.max(0, now - ts);
  if (diff < 45 * 1000) return 'just now';
  const minutes = Math.round(diff / 60000);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(diff / 3600000);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(diff / 86400000);
  if (days < 2) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  const then = new Date(ts);
  const sameYear = then.getFullYear() === new Date(now).getFullYear();
  return then.toLocaleDateString([], sameYear ? { day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short', year: 'numeric' });
}

// The first line of some text that has anything on it, trimmed and cut to `max` characters: the preview of a
// note's body under its title.
export function firstLine(text, max = 60) {
  if (typeof text !== 'string') return '';
  const line = text.split(/\r?\n/).find((l) => l.trim() !== '');
  if (!line) return '';
  const trimmed = line.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}
