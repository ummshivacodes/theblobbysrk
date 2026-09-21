import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { toHistory } from '../../src/core/history.js';

// A write to a frozen object throws (ES modules are strict), so freezing the
// input proves the function never mutates it.
function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Reflect.ownKeys(value)) deepFreeze(value[key]);
  }
  return value;
}

const KEYS = ['id', 'text', 'quad', 'createdAt', 'doneAt'];

describe('toHistory', () => {
  it('keeps id, text, quad, createdAt and doneAt', () => {
    const done = { id: 'k1', text: 'ship it', quad: 2, createdAt: 100, doneAt: 250 };
    assert.deepEqual(toHistory(done), done);
    assert.deepEqual(Object.keys(toHistory(done)), KEYS);
  });

  it('drops every other field of a thread', () => {
    const thread = {
      id: 'k1', text: 'x', quad: 1, createdAt: 1, doneAt: 2,
      status: 'done', body: 'b', focused: true, updatedAt: 9, linkTitle: 't', extra: { deep: 1 },
    };
    assert.deepEqual(toHistory(thread), { id: 'k1', text: 'x', quad: 1, createdAt: 1, doneAt: 2 });
  });

  it('returns a new object every time', () => {
    const done = { id: 'k1', text: 'x', quad: 1, createdAt: 1, doneAt: 2 };
    const a = toHistory(done);
    const b = toHistory(done);
    assert.notEqual(a, done);
    assert.notEqual(a, b);
    a.text = 'changed';
    assert.equal(done.text, 'x');
    assert.equal(b.text, 'x');
  });

  it('still has all five keys when the input lacks some', () => {
    const entry = toHistory({ id: 'k1' });
    assert.deepEqual(Object.keys(entry), KEYS);
    assert.equal(entry.doneAt, undefined);
  });

  it('keeps an untagged quad (null) as null, and any doneAt as given', () => {
    const entry = toHistory({ id: 'k1', text: 'x', quad: null, createdAt: 1, doneAt: 0 });
    assert.equal(entry.quad, null);
    assert.equal(entry.doneAt, 0);
  });

  it('does not mutate its input', () => {
    const frozen = deepFreeze({ id: 'k1', text: 'x', quad: 3, createdAt: 1, doneAt: 2, body: 'b' });
    assert.deepEqual(toHistory(frozen), { id: 'k1', text: 'x', quad: 3, createdAt: 1, doneAt: 2 });
  });

  it('is identical to the toHistory it was extracted from (taskStore.js)', () => {
    const original = ({ id, text, quad, createdAt, doneAt }) => ({ id, text, quad, createdAt, doneAt });
    const samples = [
      { id: 'a', text: 't', quad: 1, createdAt: 1, doneAt: 2 },
      { id: 'a', text: 't', quad: null, createdAt: 1 },
      { id: 'a', status: 'done', focused: true, extra: 1 },
      {},
    ];
    for (const sample of samples) assert.deepEqual(toHistory(sample), original(sample));
  });
});
