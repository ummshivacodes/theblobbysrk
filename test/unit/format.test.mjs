import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fmtWhen } from '../../src/ui/format.js';

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
