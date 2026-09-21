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
