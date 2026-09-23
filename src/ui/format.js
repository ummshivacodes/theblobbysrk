import { DONE_VISIBLE_MS } from '../core/selectors.js';

// The last stretch of DONE_VISIBLE_MS: a done row fades instead of just vanishing when the sweep in
// ui/app.js next redraws past the cutoff. Presentation-only (selectors.js stays free of it, same
// reasoning as theme.js's colours) — only how long the fade itself takes. Exported: itemRow.js needs
// the same number to size the CSS animation it drives from doneFadeMultiplier's result (see there for
// why this has to be a real animation rather than a transition).
export const DONE_FADE_MS = 4 * 1000;

// 1 while a done item is comfortably inside its visible window, ramping linearly down to 0 as it nears
// DONE_VISIBLE_MS. itemRow.js turns this into the row's fade-out animation timing. `now` is a
// parameter, as below, so it is testable without a clock or without waiting DONE_VISIBLE_MS for real.
// Same fail-safe as visibleInbox: a missing/non-finite doneAt reads as "not fading" rather than NaN
// propagating into a CSS value.
export function doneFadeMultiplier(item, now = Date.now()) {
  if (item.status !== 'done' || !Number.isFinite(item.doneAt)) return 1;
  const remaining = DONE_VISIBLE_MS - (now - item.doneAt);
  if (remaining >= DONE_FADE_MS) return 1;
  return Math.max(0, remaining) / DONE_FADE_MS;
}

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
