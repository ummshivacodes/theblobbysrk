import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeLoadNotice, RECOVERED, SAVE_FAILED } from '../../src/ui/notice.js';

test('a recovery from the backup is worth telling the person, in words that say what happened and what was kept', () => {
  const message = describeLoadNotice({ kind: 'recovered-from-backup', at: 1700000000000 });
  assert.equal(message, RECOVERED);
  assert.match(message, /backup/);
  assert.match(message, /kept/);
});

test('nothing to report is no notice', () => {
  assert.equal(describeLoadNotice(null), null);
  assert.equal(describeLoadNotice(undefined), null);
});

test('a kind this page does not know is ignored, not shown half-explained', () => {
  assert.equal(describeLoadNotice({ kind: 'something-newer', at: 1 }), null);
  assert.equal(describeLoadNotice({}), null);
  assert.equal(describeLoadNotice('recovered-from-backup'), null);
  assert.equal(describeLoadNotice(42), null);
});

test('the save-failure message says the change is not lost and that it will be retried', () => {
  assert.match(SAVE_FAILED, /stays on screen/);
  assert.match(SAVE_FAILED, /try again/);
});
