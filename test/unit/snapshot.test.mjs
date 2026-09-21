import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deepFreeze, takeSnapshot } from '../../src/ui/snapshot.js';

const state = () => ({
  threads: [{ id: 'a', text: 'x', tags: ['q'] }],
  stats: { listed: 1, done: 0 },
  history: [],
});

test('takeSnapshot returns an equal but separate copy', () => {
  const live = state();
  const snap = takeSnapshot(live);
  assert.deepEqual(snap, live);
  assert.notEqual(snap, live);
  assert.notEqual(snap.threads, live.threads);
  assert.notEqual(snap.threads[0], live.threads[0]);
});

test('the snapshot is deeply frozen: a view cannot mutate it (ES modules are strict, so writes throw)', () => {
  const snap = takeSnapshot(state());
  assert.throws(() => { snap.threads[0].id = 'b'; }, TypeError);
  assert.throws(() => { snap.threads.push({}); }, TypeError);
  assert.throws(() => { snap.stats.done = 9; }, TypeError);
  assert.throws(() => { snap.threads[0].tags.push('z'); }, TypeError);
  assert.throws(() => { snap.extra = 1; }, TypeError);
});

test('changing the live state afterwards never changes an earlier snapshot', () => {
  const live = state();
  const snap = takeSnapshot(live);
  live.threads[0].text = 'changed';
  live.threads.push({ id: 'b' });
  live.stats.done = 5;
  assert.equal(snap.threads.length, 1);
  assert.equal(snap.threads[0].text, 'x');
  assert.equal(snap.stats.done, 0);
});

test('freezing the snapshot leaves the live state writable', () => {
  const live = state();
  takeSnapshot(live);
  live.threads[0].text = 'still writable';
  live.threads.push({ id: 'b' });
  assert.equal(live.threads.length, 2);
});

test('deepFreeze tolerates primitives, null and already-frozen objects, and returns its argument', () => {
  assert.equal(deepFreeze(5), 5);
  assert.equal(deepFreeze(null), null);
  assert.equal(deepFreeze('s'), 's');
  const frozen = Object.freeze({ a: { b: 1 } });
  assert.equal(deepFreeze(frozen), frozen);
  const obj = { n: { m: [1, 2] } };
  assert.equal(deepFreeze(obj), obj);
  assert.ok(Object.isFrozen(obj.n.m));
});
