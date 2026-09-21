import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRenderGate } from '../../src/ui/renderGate.js';

// A gate over a counter and a switch: `held.on` decides whether the gate holds, `draws` counts redraws.
function setup() {
  const held = { on: false };
  const draws = { n: 0 };
  const gate = createRenderGate({ draw: () => { draws.n++; }, isHeld: () => held.on });
  return { gate, held, draws };
}

test('with nothing holding it, a request draws at once and nothing stays pending', () => {
  const { gate, draws } = setup();
  gate.request();
  assert.equal(draws.n, 1);
  assert.equal(gate.pending(), false);
});

test('while held, a request draws nothing but is remembered', () => {
  const { gate, held, draws } = setup();
  held.on = true;
  gate.request();
  assert.equal(draws.n, 0);
  assert.equal(gate.pending(), true);
});

test('release draws the remembered redraw once the hold is over', () => {
  const { gate, held, draws } = setup();
  held.on = true;
  gate.request();
  held.on = false;
  gate.release();
  assert.equal(draws.n, 1);
  assert.equal(gate.pending(), false);
});

test('release while still held draws nothing and keeps the redraw pending', () => {
  const { gate, held, draws } = setup();
  held.on = true;
  gate.request();
  gate.release();
  assert.equal(draws.n, 0);
  assert.equal(gate.pending(), true);
  held.on = false;
  gate.release();
  assert.equal(draws.n, 1);
});

test('many requests while held become exactly one draw', () => {
  const { gate, held, draws } = setup();
  held.on = true;
  for (let i = 0; i < 25; i++) gate.request();
  held.on = false;
  gate.release();
  gate.release();
  assert.equal(draws.n, 1);
});

test('release with nothing pending never draws (the extra calls the page makes are free)', () => {
  const { gate, draws } = setup();
  gate.release();
  gate.release();
  assert.equal(draws.n, 0);
});

test('a request after the hold ended draws at once and clears anything that was pending', () => {
  const { gate, held, draws } = setup();
  held.on = true;
  gate.request();
  held.on = false;
  gate.request();
  assert.equal(draws.n, 1);
  assert.equal(gate.pending(), false);
  gate.release();
  assert.equal(draws.n, 1, 'the earlier request was satisfied by that draw, not left to fire again');
});

test('the hold is asked about every time, so it can come and go', () => {
  const { gate, held, draws } = setup();
  gate.request();          // 1: free
  held.on = true;
  gate.request();          // held
  gate.request();          // held
  held.on = false;
  gate.release();          // 2: the held ones
  held.on = true;
  gate.request();          // held again
  assert.equal(draws.n, 2);
  assert.equal(gate.pending(), true);
});

test('a draw that throws does not leave a stale pending flag behind', () => {
  let boom = true;
  const gate = createRenderGate({
    draw: () => { if (boom) throw new Error('draw failed'); },
    isHeld: () => false,
  });
  assert.throws(() => gate.request(), /draw failed/);
  assert.equal(gate.pending(), false);
  boom = false;
  gate.request(); // and it works again afterwards
});
