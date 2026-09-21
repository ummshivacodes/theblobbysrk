import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHover } from '../../src/ui/hover.js';

const fakeView = () => {
  const calls = [];
  return { calls, applyHover: (id) => calls.push(id) };
};

test('nothing is hovered to begin with', () => {
  assert.equal(createHover([]).get(), null);
});

test('set(id) remembers the id and tells every view to repaint its own elements', () => {
  const [a, b, c] = [fakeView(), fakeView(), fakeView()];
  const hover = createHover([a, b, c]);
  hover.set('x1');
  assert.equal(hover.get(), 'x1');
  assert.deepEqual([a.calls, b.calls, c.calls], [['x1'], ['x1'], ['x1']]);
});

test('set(null) clears the hover on every view', () => {
  const view = fakeView();
  const hover = createHover([view]);
  hover.set('x1');
  hover.set(null);
  assert.equal(hover.get(), null);
  assert.deepEqual(view.calls, ['x1', null]);
});

test('hover only ever talks to the views it was given', () => {
  const given = fakeView();
  const other = fakeView();
  createHover([given]).set('x1');
  assert.deepEqual(other.calls, []);
});
