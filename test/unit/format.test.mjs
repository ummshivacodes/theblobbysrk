import { test } from 'node:test';
import assert from 'node:assert/strict';
import { doneFadeMultiplier, fmtWhen, fmtAgo, firstLine } from '../../src/ui/format.js';
import { DONE_VISIBLE_MS } from '../../src/core/selectors.js';

// Assertions avoid the exact clock format (12h/24h, am/pm) because it follows the machine's locale.
const at = (y, m, d, h = 12, min = 0) => new Date(y, m - 1, d, h, min).getTime();
const now = new Date(2026, 8, 21, 15, 30); // 21 Sep 2026, 15:30

test('no timestamp gives an empty string', () => {
  assert.equal(fmtWhen(undefined, now), '');
  assert.equal(fmtWhen(0, now), '');
  assert.equal(fmtWhen(null, now), '');
});

test('earlier the same day reads "today · <time>"', () => {
  const out = fmtWhen(at(2026, 9, 21, 9, 5), now);
  assert.match(out, /^today · \S+/);
});

test('the previous calendar day reads "yesterday · <time>"', () => {
  const out = fmtWhen(at(2026, 9, 20, 23, 59), now);
  assert.match(out, /^yesterday · \S+/);
});

test('"yesterday" works across a month boundary', () => {
  const firstOfMonth = new Date(2026, 9, 1, 8, 0); // 1 Oct 2026
  assert.match(fmtWhen(at(2026, 9, 30, 20, 0), firstOfMonth), /^yesterday · /);
});

test('anything older is just the day and month, with no time', () => {
  const out = fmtWhen(at(2026, 9, 1), now);
  assert.doesNotMatch(out, /today|yesterday|:/);
  assert.ok(out.length > 0);
});

test('the boundary is the calendar day, not 24 hours', () => {
  const justAfterMidnight = new Date(2026, 8, 21, 0, 5);
  // 23:50 the evening before is only 15 minutes earlier, but it is yesterday.
  assert.match(fmtWhen(at(2026, 9, 20, 23, 50), justAfterMidnight), /^yesterday · /);
});

// ---- fmtAgo / firstLine (the Notes screen) ----

const NOW = new Date(2026, 8, 21, 15, 30).getTime();
const ago = (ms) => NOW - ms;
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

test('fmtAgo: no usable timestamp gives an empty string', () => {
  for (const bad of [undefined, null, 0, -5, NaN, 'x', {}]) assert.equal(fmtAgo(bad, NOW), '', String(bad));
});

test('fmtAgo: under a minute is "just now"; a timestamp in the future counts as just now, not a negative age', () => {
  assert.equal(fmtAgo(ago(0), NOW), 'just now');
  assert.equal(fmtAgo(ago(30 * 1000), NOW), 'just now');
  assert.equal(fmtAgo(NOW + 5 * MIN, NOW), 'just now');
});

test('fmtAgo: minutes, then hours', () => {
  assert.equal(fmtAgo(ago(60 * 1000), NOW), '1 min ago');
  assert.equal(fmtAgo(ago(5 * MIN), NOW), '5 min ago');
  assert.equal(fmtAgo(ago(59 * MIN), NOW), '59 min ago');
  assert.equal(fmtAgo(ago(60 * MIN), NOW), '1h ago');
  assert.equal(fmtAgo(ago(2 * HOUR + 10 * MIN), NOW), '2h ago');
  assert.equal(fmtAgo(ago(23 * HOUR), NOW), '23h ago');
});

test('fmtAgo: the next day is "yesterday", then a count of days up to a week', () => {
  assert.equal(fmtAgo(ago(30 * HOUR), NOW), 'yesterday');
  assert.equal(fmtAgo(ago(3 * DAY), NOW), '3 days ago');
  assert.equal(fmtAgo(ago(6 * DAY), NOW), '6 days ago');
});

test('fmtAgo: past a week it is the date, with the year only when it is not this year', () => {
  const thisYear = fmtAgo(new Date(2026, 7, 1).getTime(), NOW);
  assert.doesNotMatch(thisYear, /2026/);
  assert.match(thisYear, /1/);
  const otherYear = fmtAgo(new Date(2025, 2, 9).getTime(), NOW);
  assert.match(otherYear, /2025/);
});

test('firstLine: the first line with anything on it, trimmed', () => {
  assert.equal(firstLine('one\ntwo\nthree'), 'one');
  assert.equal(firstLine('\n\n   \n  spaced  \nnext'), 'spaced');
  assert.equal(firstLine('win\r\nlines'), 'win');
});

test('firstLine: long lines are cut with an ellipsis, exactly at the limit', () => {
  const long = 'x'.repeat(100);
  const cut = firstLine(long, 20);
  assert.equal(cut.length, 20);
  assert.ok(cut.endsWith('…'));
  assert.equal(firstLine('y'.repeat(20), 20), 'y'.repeat(20));
});

test('firstLine: empty, blank and non-string input give an empty string', () => {
  for (const bad of ['', '   ', '\n\n', undefined, null, 42, {}]) assert.equal(firstLine(bad), '', String(bad));
});

test('doneFadeMultiplier: 1 for anything that is not done, regardless of doneAt', () => {
  assert.equal(doneFadeMultiplier({ status: 'axis', doneAt: 0 }, 1e15), 1);
  assert.equal(doneFadeMultiplier({ status: 'dump' }, 1e15), 1);
});

test('doneFadeMultiplier: 1 right after being crossed off, and for most of the visible window', () => {
  const item = { status: 'done', doneAt: 1000 };
  assert.equal(doneFadeMultiplier(item, 1000), 1);
  assert.equal(doneFadeMultiplier(item, 1000 + DONE_VISIBLE_MS - 4000), 1); // right at the edge of the fade window
});

test('doneFadeMultiplier: ramps linearly to 0 across the last stretch, and clamps at the cutoff', () => {
  const item = { status: 'done', doneAt: 1000 };
  const halfway = doneFadeMultiplier(item, 1000 + DONE_VISIBLE_MS - 2000); // 2s of a 4s fade window left
  assert.ok(halfway > 0.4 && halfway < 0.6, `expected roughly 0.5, got ${halfway}`);
  assert.equal(doneFadeMultiplier(item, 1000 + DONE_VISIBLE_MS), 0);
  assert.equal(doneFadeMultiplier(item, 1000 + DONE_VISIBLE_MS + 5000), 0); // long past: still 0, not negative
});

test('doneFadeMultiplier: defaults `now` to the real clock', () => {
  assert.equal(doneFadeMultiplier({ status: 'done', doneAt: Date.now() }), 1);
});

test('doneFadeMultiplier: a missing or non-finite doneAt reads as "not fading" (1), not NaN', () => {
  assert.equal(doneFadeMultiplier({ status: 'done' }, 1e15), 1);
  assert.equal(doneFadeMultiplier({ status: 'done', doneAt: 'not a number' }, 1e15), 1);
  assert.equal(doneFadeMultiplier({ status: 'done', doneAt: NaN }, 1e15), 1);
});
