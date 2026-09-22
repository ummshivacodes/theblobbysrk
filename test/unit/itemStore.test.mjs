// Specification of the item store (src/core/itemStore.js): the dump -> axis -> resolving -> done state
// machine, focus, the lifetime scoreboard and history, and loading a saved file.
//
// Public API only. Each test drives the functions the store returns and reads `store.state`;
// persistence is a fake in-memory port and `onChange` a counter, exactly what the app injects. No
// source-text checks, no DOM, no Electron: it runs in plain Node and reads as the rules.
//
// Time. The store touches the clock in two places: Date.now() (ids, createdAt, doneAt) and one
// setTimeout (the strike-through between "resolving" and "done"). Tests that involve either run on
// node:test's fake clock, so nothing sleeps. That clock is process-wide: do not make these suites
// concurrent.
//
// Not here on purpose, because it no longer lives in the store: activeThreads (the selectors' tests),
// COLORS (ui/theme) and the no-DOM rule (the architecture test). The note operations (addNote, fileAsNote,
// setBody, ...) have their own file: itemStore.notes.test.mjs.
//
// A thread cannot be LOADED as "resolving": loadState puts it back on the axis (see the loadState suite).
// So a test that needs one makes it the honest way, with openWith('resolving'): a real tap on the
// checkmark of an axis thread, before the 700 ms are up. Those suites run on the fake clock.
//
// Run:  node --test "test/unit/**/*.test.mjs"   (quote the glob: a bare `node --test` would also pick
// up the Electron tests)
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';

import { createItemStore } from '../../src/core/itemStore.js';

const RESOLVE_MS = 700;         // how long a crossed-off thread stays "resolving" before it is done
const NOW = 1_700_000_000_000;  // where the fake clock starts

// ---------- fixtures and helpers ----------

// A thread as it sits in a saved file. Tagged (quad 1) unless a test says otherwise, so tests about
// where a thread *sits* never depend on its tag.
const thread = (id, status, extra = {}) => ({
  id,
  text: `task ${id}`,
  quad: 1,
  status,
  createdAt: 1,
  ...(status === 'done' ? { doneAt: 99 } : {}),
  ...extra,
});

// A history record as the store writes it: exactly these five fields.
const historyEntry = (id) => ({ id, text: `task ${id}`, quad: 1, createdAt: 1, doneAt: 99 });

// A store wired to a fake disk holding `saved` (a whole file, or null on a first run) and to an
// onChange counter. Every save is snapshotted the moment it happens: the store hands over its own live
// state, so a later mutation must not be able to rewrite what an earlier save saw.
function newStore(saved = null) {
  const calls = { saves: [], changes: 0 };
  const persistence = {
    loadThreads: async () => saved,
    saveThreads: (payload) => {
      calls.saves.push(structuredClone(payload));
      return Promise.resolve(true);
    },
  };
  const store = createItemStore(persistence, () => { calls.changes += 1; });
  return { store, calls };
}

// A store that has loaded a saved file holding `threads` (plus optional stats and history) through the
// public loadState(), with the counters zeroed afterwards so a test counts only what it does itself.
async function openStore(threads, rest = {}) {
  const ctx = newStore({ threads, ...rest });
  await ctx.store.loadState();
  ctx.calls.saves.length = 0;
  ctx.calls.changes = 0;
  return ctx;
}

// A store holding one thread, t1, in the given status (plus `others` beside it). "resolving" cannot be
// loaded, so it is reached by tapping the checkmark; the caller's suite must be on the fake clock.
async function openWith(status, extra = {}, others = []) {
  if (status !== 'resolving') return openStore([...others, thread('t1', status, extra)]);
  const ctx = await openStore([...others, thread('t1', 'axis', extra)]);
  ctx.store.resolveThread('t1');
  ctx.calls.saves.length = 0;
  ctx.calls.changes = 0;
  return ctx;
}

const byId = (store, id) => store.state.threads.find((t) => t.id === id);
const a = (word) => `${/^[aeiou]/.test(word) ? 'an' : 'a'} ${word}`;  // for generated test names
const effects = (calls) => ({ saves: calls.saves.length, changes: calls.changes });
const assertSavedAndRenderedOnce = (calls) => assert.deepEqual(effects(calls), { saves: 1, changes: 1 });
const assertKeyGone = (obj, key) => {
  assert.equal(Object.hasOwn(obj, key), false, `${key} should be gone, not just falsy`);
};

// An impossible move must be a true no-op: the same state, nothing saved, no re-render.
function assertNoOp({ store, calls }, move) {
  const stateBefore = structuredClone(store.state);
  const effectsBefore = effects(calls);
  move();
  assert.deepEqual(store.state, stateBefore, 'the state changed');
  assert.deepEqual(effects(calls), effectsBefore, 'something was saved or re-rendered');
}

// Puts the suite's tests on the fake clock, started at NOW. Registered per describe: switched on before
// each test builds its store, and always switched off again afterwards.
function useFakeClock() {
  beforeEach(() => { mock.timers.enable({ apis: ['setTimeout', 'Date'], now: NOW }); });
  afterEach(() => { mock.timers.reset(); });
}

// ---------- the store ----------

describe('createItemStore', () => {
  it('starts empty, in the current file format: no threads, a zeroed scoreboard, no history', () => {
    const { store } = newStore();
    assert.deepEqual(store.state, { version: 2, threads: [], stats: { listed: 0, done: 0 }, history: [] });
  });

  // The API surface is pinned on purpose. When a phase adds operations, this list is meant to be edited
  // deliberately in the same commit (Phase 3 added the note operations and renamed deleteTask).
  it('exposes exactly the live state and fifteen operations', () => {
    const { store } = newStore();
    assert.deepEqual(Object.keys(store).sort(), [
      'addNote', 'addTask', 'deleteItem', 'dispatchToAxis', 'fileAsNote', 'loadState', 'recallToDump',
      'reopenTask', 'resolveThread', 'setBody', 'setLinkTitle', 'setText', 'state', 'tagTask',
      'toggleFocus', 'unfileNote',
    ]);
    for (const [name, value] of Object.entries(store)) {
      if (name !== 'state') assert.equal(typeof value, 'function', `${name} should be a function`);
    }
  });

  it('keeps presentation and derived views out: COLORS, activeThreads and persist are not part of it', () => {
    const { store } = newStore();
    for (const name of ['COLORS', 'activeThreads', 'persist']) {
      assert.equal(name in store, false, `${name} must not be part of the store's API`);
    }
  });
});

describe('addTask', () => {
  useFakeClock();

  it('captures the text as an untagged dump thread stamped with the capture time', () => {
    const { store } = newStore();
    store.addTask('hello');
    assert.equal(store.state.threads.length, 1);
    const [t] = store.state.threads;
    assert.equal(t.text, 'hello');
    assert.equal(t.quad, null);
    assert.equal(t.status, 'dump');
    assert.equal(t.createdAt, NOW);
  });

  it('returns the new thread id, which the other operations accept', () => {
    const { store } = newStore();
    const id = store.addTask('hello');
    assert.equal(typeof id, 'string');
    assert.equal(store.state.threads[0].id, id);
    store.tagTask(id, 2);
    assert.equal(byId(store, id).quad, 2);
  });

  it('counts the capture in the lifetime scoreboard: listed goes up, done does not', () => {
    const { store } = newStore();
    store.addTask('hello');
    assert.deepEqual(store.state.stats, { listed: 1, done: 0 });
  });

  it('saves once and notifies once', () => {
    const { store, calls } = newStore();
    store.addTask('hello');
    assertSavedAndRenderedOnce(calls);
  });

  it('saves the state as it stands after the change, not before', () => {
    const { store, calls } = newStore();
    store.addTask('hello');
    const [saved] = calls.saves;
    assert.equal(saved.threads.length, 1);
    assert.equal(saved.threads[0].text, 'hello');
    assert.equal(saved.stats.listed, 1);
  });
});

describe('tagTask', () => {
  useFakeClock();

  for (const status of ['dump', 'axis']) {
    it(`tagging ${a(status)} thread sets the quad and never changes its status`, async () => {
      const { store } = await openStore([thread('t1', status, { quad: 1 })]);
      store.tagTask('t1', 3);
      assert.equal(byId(store, 't1').quad, 3);
      assert.equal(byId(store, 't1').status, status);
    });
  }

  it('tags an untagged dump thread', async () => {
    const { store } = await openStore([thread('t1', 'dump', { quad: null })]);
    store.tagTask('t1', 3);
    assert.equal(byId(store, 't1').quad, 3);
  });

  it('changes nothing but the quad', async () => {
    const { store } = await openStore([thread('t1', 'axis', { quad: 1, focused: true })]);
    const before = structuredClone(byId(store, 't1'));
    store.tagTask('t1', 4);
    assert.deepEqual(byId(store, 't1'), { ...before, quad: 4 });
  });

  it('saves once and notifies once', async () => {
    const { store, calls } = await openStore([thread('t1', 'dump', { quad: null })]);
    store.tagTask('t1', 3);
    assertSavedAndRenderedOnce(calls);
  });

  for (const status of ['resolving', 'done']) {
    it(`ignores ${a(status)} thread: a crossed-off task cannot be retagged`, async () => {
      const ctx = await openWith(status, { quad: 1 });
      assertNoOp(ctx, () => ctx.store.tagTask('t1', 4));
    });
  }

  it('ignores a note: a note has no tag', async () => {
    const ctx = await openStore([thread('n1', 'note', { quad: null })]);
    assertNoOp(ctx, () => ctx.store.tagTask('n1', 2));
  });
});

describe('dispatchToAxis', () => {
  useFakeClock();

  it('moves a dump thread onto the axis and keeps its tag', async () => {
    const { store } = await openStore([thread('t1', 'dump', { quad: 2 })]);
    store.dispatchToAxis('t1');
    assert.equal(byId(store, 't1').status, 'axis');
    assert.equal(byId(store, 't1').quad, 2);
  });

  it('saves once and notifies once', async () => {
    const { store, calls } = await openStore([thread('t1', 'dump')]);
    store.dispatchToAxis('t1');
    assertSavedAndRenderedOnce(calls);
  });

  for (const status of ['axis', 'resolving', 'done', 'note']) {
    it(`ignores ${a(status)} thread: only a dump thread can be pushed onto the axis`, async () => {
      const ctx = await openWith(status);
      assertNoOp(ctx, () => ctx.store.dispatchToAxis('t1'));
    });
  }

  it('ignores an untagged dump thread: with no tag it has no order yet', async () => {
    const ctx = await openStore([thread('t1', 'dump', { quad: null })]);
    assertNoOp(ctx, () => ctx.store.dispatchToAxis('t1'));
  });

  it('focuses the thread it pushes, and un-focuses whatever was focused before: it is what you\'re on now', async () => {
    const { store } = await openStore([thread('was-focused', 'axis', { focused: true }), thread('t1', 'dump', { quad: 2 })]);
    store.dispatchToAxis('t1');
    assert.equal(byId(store, 't1').focused, true);
    assert.equal(byId(store, 'was-focused').focused, undefined);
  });
});

describe('recallToDump', () => {
  useFakeClock();

  it('moves an axis thread back to the dump and keeps its tag', async () => {
    const { store } = await openStore([thread('t1', 'axis', { quad: 3 })]);
    store.recallToDump('t1');
    assert.equal(byId(store, 't1').status, 'dump');
    assert.equal(byId(store, 't1').quad, 3);
  });

  it('drops the focus: a recalled thread is no longer the focused one', async () => {
    const { store } = await openStore([thread('t1', 'axis', { focused: true })]);
    store.recallToDump('t1');
    assertKeyGone(byId(store, 't1'), 'focused');
  });

  it('saves once and notifies once', async () => {
    const { store, calls } = await openStore([thread('t1', 'axis')]);
    store.recallToDump('t1');
    assertSavedAndRenderedOnce(calls);
  });

  for (const status of ['dump', 'resolving', 'done', 'note']) {
    it(`ignores ${a(status)} thread: only an axis thread can be recalled`, async () => {
      const ctx = await openWith(status);
      assertNoOp(ctx, () => ctx.store.recallToDump('t1'));
    });
  }
});

describe('resolveThread', () => {
  useFakeClock();

  // Taps the checkmark on a focused axis thread (at NOW), and hands back the counters as they stand
  // straight after the tap.
  async function tapCheckmark() {
    const ctx = await openStore([
      thread('x1', 'axis', { text: 'ship it', quad: 2, createdAt: 5, focused: true }),
    ]);
    ctx.store.resolveThread('x1');
    return ctx;
  }

  // The same, then waits out the whole strike-through.
  async function crossedOff() {
    const ctx = await tapCheckmark();
    mock.timers.tick(RESOLVE_MS);
    return ctx;
  }

  it('strikes the thread through at once: it is resolving and the UI is told', async () => {
    const { store, calls } = await tapCheckmark();
    assert.equal(byId(store, 'x1').status, 'resolving');
    assert.equal(calls.changes, 1);
  });

  it('does not save the transient resolving state', async () => {
    const { calls } = await tapCheckmark();
    assert.equal(calls.saves.length, 0);
  });

  it('finishes exactly 700 ms after the tap: still resolving at 699 ms, done at 700 ms', async () => {
    const { store } = await tapCheckmark();
    mock.timers.tick(RESOLVE_MS - 1);
    assert.equal(byId(store, 'x1').status, 'resolving');
    mock.timers.tick(1);
    assert.equal(byId(store, 'x1').status, 'done');
  });

  it('counts, records and saves nothing before the 700 ms are up', async () => {
    const { store, calls } = await tapCheckmark();
    mock.timers.tick(RESOLVE_MS - 1);
    assert.deepEqual(store.state.stats, { listed: 1, done: 0 });
    assert.deepEqual(store.state.history, []);
    assert.deepEqual(effects(calls), { saves: 0, changes: 1 });
  });

  it('stamps doneAt at the moment it becomes done', async () => {
    const { store } = await crossedOff();
    assert.equal(byId(store, 'x1').doneAt, NOW + RESOLVE_MS);
  });

  it('drops the focus when it becomes done', async () => {
    const { store } = await crossedOff();
    assertKeyGone(byId(store, 'x1'), 'focused');
  });

  it('counts it in the scoreboard when it becomes done: done goes up by one, listed does not', async () => {
    const { store } = await crossedOff();
    assert.deepEqual(store.state.stats, { listed: 1, done: 1 });
  });

  it('records exactly one history entry holding only {id, text, quad, createdAt, doneAt}', async () => {
    const { store } = await crossedOff();
    assert.deepEqual(store.state.history, [
      { id: 'x1', text: 'ship it', quad: 2, createdAt: 5, doneAt: NOW + RESOLVE_MS },
    ]);
  });

  it('saves once when it becomes done and tells the UI a second time', async () => {
    const { calls } = await crossedOff();
    assert.deepEqual(effects(calls), { saves: 1, changes: 2 });
  });

  it('saves the finished state, never the transient resolving one', async () => {
    const { calls } = await crossedOff();
    const [saved] = calls.saves;
    assert.equal(saved.threads[0].status, 'done');
    assert.equal(saved.stats.done, 1);
    assert.equal(saved.history.length, 1);
  });

  // Only an axis thread can be crossed off. (Before Phase 3 nothing in the store stopped a dump thread
  // getting here; only the UI's buttons did. This used to be pinned as a CHARACTERIZATION test.)
  for (const status of ['dump', 'done', 'note']) {
    it(`ignores ${a(status)} thread: only an axis thread can be crossed off`, async () => {
      const ctx = await openWith(status);
      assertNoOp(ctx, () => {
        ctx.store.resolveThread('t1');
        mock.timers.tick(RESOLVE_MS); // a wrongly scheduled completion would fire here
      });
    });
  }

  it('a second tap inside the beat does nothing: the point is counted once', async () => {
    const { store } = await tapCheckmark();
    store.resolveThread('x1');
    mock.timers.tick(RESOLVE_MS);
    assert.deepEqual(store.state.stats, { listed: 1, done: 1 });
    assert.equal(store.state.history.length, 1);
  });

  it('deleting the thread inside the beat cancels the close: it never completes, scores or saves', async () => {
    const { store, calls } = await tapCheckmark();
    store.deleteItem('x1');
    const before = { ...effects(calls), stats: structuredClone(store.state.stats) };
    mock.timers.tick(RESOLVE_MS * 2);
    assert.deepEqual(store.state.threads, []);
    assert.deepEqual(store.state.stats, before.stats);
    assert.deepEqual(store.state.history, []);
    assert.deepEqual(effects(calls), { saves: before.saves, changes: before.changes });
  });
});

describe('reopenTask', () => {
  useFakeClock();

  // A done thread that the scoreboard and the history both know about, next to an axis thread and a
  // history entry belonging to some other (already deleted) task.
  const openWithDoneThread = () => openStore(
    [thread('n', 'done', { doneAt: 99 }), thread('x', 'axis')],
    { stats: { listed: 2, done: 1 }, history: [historyEntry('n'), historyEntry('other')] },
  );

  it('puts a done thread straight back on the axis and forgets when it was done', async () => {
    const { store } = await openWithDoneThread();
    store.reopenTask('n');
    assert.equal(byId(store, 'n').status, 'axis');
    assertKeyGone(byId(store, 'n'), 'doneAt');
  });

  it('gives the scoreboard point back: done goes down by one, listed does not', async () => {
    const { store } = await openWithDoneThread();
    store.reopenTask('n');
    assert.deepEqual(store.state.stats, { listed: 2, done: 0 });
  });

  it('removes that thread from the history and keeps every other entry', async () => {
    const { store } = await openWithDoneThread();
    store.reopenTask('n');
    assert.deepEqual(store.state.history.map((h) => h.id), ['other']);
  });

  it('saves once and notifies once', async () => {
    const { store, calls } = await openWithDoneThread();
    store.reopenTask('n');
    assertSavedAndRenderedOnce(calls);
  });

  it('never lets the done count go below zero', async () => {
    // A file whose scoreboard is behind its threads: a done thread, but done: 0.
    const { store } = await openStore([thread('n', 'done')], { stats: { listed: 1, done: 0 }, history: [] });
    store.reopenTask('n');
    assert.equal(store.state.stats.done, 0);
  });

  for (const status of ['dump', 'axis', 'resolving', 'note']) {
    it(`ignores ${a(status)} thread: only a done thread can be reopened`, async () => {
      const ctx = await openWith(status);
      assertNoOp(ctx, () => ctx.store.reopenTask('t1'));
    });
  }
});

describe('deleteItem', () => {
  it('removes that thread and only that thread', async () => {
    const { store } = await openStore([thread('a', 'dump'), thread('b', 'dump'), thread('c', 'axis')]);
    store.deleteItem('b');
    assert.deepEqual(store.state.threads.map((t) => t.id), ['a', 'c']);
  });

  it('keeps store.state the same live object', async () => {
    const { store } = await openStore([thread('a', 'dump'), thread('b', 'dump')]);
    const live = store.state;
    store.deleteItem('a');
    assert.equal(store.state, live);
  });

  it('saves once and notifies once', async () => {
    const { store, calls } = await openStore([thread('a', 'dump')]);
    store.deleteItem('a');
    assertSavedAndRenderedOnce(calls);
  });

  it('never shrinks the lifetime scoreboard: listed and done stay as they were', async () => {
    const { store } = await openStore(
      [thread('a', 'dump'), thread('n', 'done')],
      { stats: { listed: 5, done: 2 }, history: [historyEntry('n')] },
    );
    store.deleteItem('a');
    store.deleteItem('n');
    assert.deepEqual(store.state.stats, { listed: 5, done: 2 });
  });

  it('keeps the history of a deleted done thread: the record outlives the row', async () => {
    const { store } = await openStore(
      [thread('n', 'done')],
      { stats: { listed: 1, done: 1 }, history: [historyEntry('n')] },
    );
    store.deleteItem('n');
    assert.deepEqual(store.state.threads, []);
    assert.deepEqual(store.state.history.map((h) => h.id), ['n']);
  });

  // Like every other move, deleting something that is not there is a true no-op (before Phase 3 it
  // still saved and re-rendered).
  it('ignores an unknown id: no change, no save, no re-render', async () => {
    const ctx = await openStore([thread('a', 'dump')]);
    assertNoOp(ctx, () => ctx.store.deleteItem('nope'));
  });

  it('deletes a note like any other item, and it never counted as listed', async () => {
    const { store } = await openStore([thread('n1', 'note', { quad: null })], { stats: { listed: 0, done: 0 } });
    store.deleteItem('n1');
    assert.deepEqual(store.state.threads, []);
    assert.deepEqual(store.state.stats, { listed: 0, done: 0 });
  });
});

describe('toggleFocus', () => {
  useFakeClock();

  const focusedIds = (store) => store.state.threads.filter((t) => t.focused).map((t) => t.id);

  it('focuses an axis thread', async () => {
    const { store } = await openStore([thread('A', 'axis'), thread('B', 'axis')]);
    store.toggleFocus('A');
    assert.deepEqual(focusedIds(store), ['A']);
  });

  it('keeps a single focus: focusing another axis thread moves it', async () => {
    const { store } = await openStore([thread('A', 'axis', { focused: true }), thread('B', 'axis')]);
    store.toggleFocus('B');
    assert.deepEqual(focusedIds(store), ['B']);
  });

  it('clears the focus when the focused thread is toggled again', async () => {
    const { store } = await openStore([thread('A', 'axis', { focused: true })]);
    store.toggleFocus('A');
    assert.deepEqual(focusedIds(store), []);
  });

  it('clears the focus by removing the key: no focused: false in memory or in the saved file', async () => {
    const { store, calls } = await openStore([thread('A', 'axis'), thread('B', 'axis')]);
    store.toggleFocus('A');
    store.toggleFocus('B');
    store.toggleFocus('B');
    for (const t of store.state.threads) assertKeyGone(t, 'focused');
    for (const t of calls.saves.at(-1).threads) assertKeyGone(t, 'focused');
  });

  it('saves once and notifies once per effective toggle', async () => {
    const { store, calls } = await openStore([thread('A', 'axis'), thread('B', 'axis')]);
    store.toggleFocus('A');
    store.toggleFocus('B');
    store.toggleFocus('B');
    assert.deepEqual(effects(calls), { saves: 3, changes: 3 });
  });

  for (const status of ['dump', 'resolving', 'done', 'note']) {
    it(`ignores ${a(status)} thread, leaving the focus alone: only axis threads take focus`, async () => {
      // A is focused, so a refused toggle must not clear it either.
      const ctx = await openWith(status, {}, [thread('A', 'axis', { focused: true })]);
      assertNoOp(ctx, () => ctx.store.toggleFocus('t1'));
    });
  }
});

// Every move treats an id that is not in the list as nothing to do.
describe('an unknown id', () => {
  useFakeClock();  // so an unknown id that wrongly scheduled a completion would fire inside the test

  const guardedMoves = {
    tagTask: (store) => store.tagTask('nope', 2),
    dispatchToAxis: (store) => store.dispatchToAxis('nope'),
    recallToDump: (store) => store.recallToDump('nope'),
    resolveThread: (store) => store.resolveThread('nope'),
    reopenTask: (store) => store.reopenTask('nope'),
    toggleFocus: (store) => store.toggleFocus('nope'),
    deleteItem: (store) => store.deleteItem('nope'),
  };

  for (const [name, move] of Object.entries(guardedMoves)) {
    it(`is ignored by ${name}: no change, no save, no re-render`, async () => {
      const ctx = await openStore([thread('t1', 'axis', { focused: true })]);
      assertNoOp(ctx, () => {
        move(ctx.store);
        mock.timers.tick(RESOLVE_MS);
      });
    });
  }
});

describe('loadState', () => {
  const EMPTY_STATE = { version: 2, threads: [], stats: { listed: 0, done: 0 }, history: [] };

  // A file from before the scoreboard and the history existed: threads only (one done, one on the axis).
  const legacyFile = () => ({
    threads: [
      { id: 'a', text: 'a', quad: 1, status: 'done', createdAt: 1, doneAt: 5, extra: 'x' },
      { id: 'b', text: 'b', quad: 2, status: 'axis', createdAt: 2 },
    ],
  });

  it('first run: no saved file leaves the state empty, tells the UI once, writes nothing', async () => {
    const { store, calls } = newStore(null);
    await store.loadState();
    assert.deepEqual(store.state, EMPTY_STATE);
    assert.deepEqual(effects(calls), { saves: 0, changes: 1 });
  });

  it('adopts the saved threads, tells the UI once and writes nothing', async () => {
    const file = legacyFile();
    const expectedThreads = structuredClone(file.threads);
    const { store, calls } = newStore(file);
    await store.loadState();
    assert.deepEqual(store.state.threads, expectedThreads);
    assert.deepEqual(effects(calls), { saves: 0, changes: 1 });
  });

  it('a file without stats is seeded: listed = every thread, done = the done ones', async () => {
    const { store } = newStore(legacyFile());
    await store.loadState();
    assert.deepEqual(store.state.stats, { listed: 2, done: 1 });
  });

  it('a file without history is seeded from its done threads, stripped to history fields', async () => {
    const { store } = newStore(legacyFile());
    await store.loadState();
    assert.deepEqual(store.state.history, [{ id: 'a', text: 'a', quad: 1, createdAt: 1, doneAt: 5 }]);
  });

  it('a complete file is taken as it is: stats and history are not recomputed from the threads', async () => {
    const file = {
      threads: [thread('a', 'dump')],
      stats: { listed: 9, done: 4 },
      history: [historyEntry('h')],
    };
    const expected = { ...structuredClone(file), version: 2 };  // an older file is stamped with the current version
    const { store } = newStore(file);
    await store.loadState();
    assert.deepEqual(store.state, expected);
  });

  it('seeds only what a file lacks: a file with stats but no history keeps its stats', async () => {
    const { store } = newStore({ ...legacyFile(), stats: { listed: 7, done: 3 } });
    await store.loadState();
    assert.deepEqual(store.state.stats, { listed: 7, done: 3 });
    assert.deepEqual(store.state.history, [{ id: 'a', text: 'a', quad: 1, createdAt: 1, doneAt: 5 }]);
  });

  it('seeds only what a file lacks: a file with history but no stats keeps its history', async () => {
    const { store } = newStore({ ...legacyFile(), history: [historyEntry('h')] });
    await store.loadState();
    assert.deepEqual(store.state.history, [historyEntry('h')]);
    assert.deepEqual(store.state.stats, { listed: 2, done: 1 });
  });

  const malformedFiles = [
    ['threads is a string', () => ({
      threads: 'garbage',
      stats: { listed: 5, done: 2 },
      history: [historyEntry('h')],
    })],
    ['threads is an object', () => ({ threads: { a: 1 } })],
    ['there is no threads key', () => ({ stats: { listed: 5, done: 2 } })],
    ['the file is a list', () => []],
    ['the file is a bare string', () => 'garbage'],
  ];
  for (const [label, makeFile] of malformedFiles) {
    it(`ignores a malformed file (${label}): state stays empty, UI told once, nothing written`, async () => {
      const { store, calls } = newStore(makeFile());
      await store.loadState();
      assert.deepEqual(store.state, EMPTY_STATE);
      assert.deepEqual(effects(calls), { saves: 0, changes: 1 });
    });
  }

  it('an older file is upgraded to the current format in memory', async () => {
    const { store } = newStore(legacyFile());
    await store.loadState();
    assert.equal(store.state.version, 2);
  });

  it('a scoreboard missing a field is reseeded from the threads, not trusted (it used to turn into NaN)', async () => {
    const { store } = newStore({ threads: [thread('a', 'done'), thread('b', 'axis')], stats: { listed: 2 } });
    await store.loadState();
    assert.deepEqual(store.state.stats, { listed: 2, done: 1 });
  });

  it('a thread saved mid-close goes back on the axis: it was never counted, and no timer will finish it', async () => {
    const { store, calls } = newStore({
      threads: [thread('x', 'resolving', { focused: true }), thread('y', 'axis')],
      stats: { listed: 2, done: 0 },
      history: [],
    });
    await store.loadState();
    assert.equal(byId(store, 'x').status, 'axis');
    assert.equal(byId(store, 'x').focused, true, 'nothing else about it changes');
    assert.deepEqual(store.state.stats, { listed: 2, done: 0 });
    assert.deepEqual(store.state.history, []);
    assert.equal(calls.saves.length, 0, 'loading never writes');
  });

  it('keeps what a newer version of the app wrote, so an older one cannot erase it', async () => {
    const { store } = newStore({ threads: [], extra: { from: 'a newer app' } });
    await store.loadState();
    assert.deepEqual(store.state.extra, { from: 'a newer app' });
  });

  it('fills store.state in place: it stays the same live object', async () => {
    const { store } = newStore(legacyFile());
    const live = store.state;
    await store.loadState();
    assert.equal(store.state, live);
    assert.equal(store.state.threads.length, 2);
  });
});

describe('the life of a task', () => {
  useFakeClock();

  // One task walked through every state with only the public API and the id addTask hands back.
  function liveThroughToDone() {
    const ctx = newStore();
    const id = ctx.store.addTask('ship it');
    ctx.store.tagTask(id, 2);
    ctx.store.dispatchToAxis(id);
    ctx.store.toggleFocus(id);
    ctx.store.resolveThread(id);
    mock.timers.tick(RESOLVE_MS);
    return { ...ctx, id };
  }

  it('capture, tag, push, focus, cross off: the thread ends done, unfocused, scored and on record', () => {
    const { store, id } = liveThroughToDone();
    const t = byId(store, id);
    assert.equal(t.status, 'done');
    assert.equal(t.quad, 2);
    assertKeyGone(t, 'focused');
    assert.deepEqual(store.state.stats, { listed: 1, done: 1 });
    assert.deepEqual(store.state.history.map((h) => h.id), [id]);
  });

  it('reopening it puts it back on the axis and takes it out of the books', () => {
    const { store, id } = liveThroughToDone();
    store.reopenTask(id);
    assert.equal(byId(store, id).status, 'axis');
    assert.deepEqual(store.state.stats, { listed: 1, done: 0 });
    assert.deepEqual(store.state.history, []);
  });

  it('what it last saved is exactly the state in memory, and reloads into an identical state', async () => {
    const { store, calls } = liveThroughToDone();
    const lastSave = calls.saves.at(-1);
    assert.deepEqual(lastSave, store.state);

    const restarted = newStore(lastSave);
    await restarted.store.loadState();
    assert.deepEqual(restarted.store.state, store.state);
  });
});

// A tag is one of Q1..Q4. "No tag" (null) is not something you can tag a thread with: an axis thread
// must always have one, and dispatchToAxis relies on it. (Found by lane G's independent tests.)
describe('tagTask only accepts a real tag', () => {
  const NOT_TAGS = [0, 5, 9, -1, 2.5, NaN, '2', null, undefined, true, {}, [2]];

  for (const status of ['dump', 'axis']) {
    for (const bad of NOT_TAGS) {
      it(`ignores ${JSON.stringify(bad) ?? String(bad)} on ${a(status)} thread: nothing changes, nothing is saved`, async () => {
        const ctx = await openStore([thread('t1', status, { quad: 2 })]);
        assertNoOp(ctx, () => ctx.store.tagTask('t1', bad));
        assert.equal(byId(ctx.store, 't1').quad, 2, 'the thread keeps the tag it had');
      });
    }
  }

  for (const q of [1, 2, 3, 4]) {
    it(`accepts Q${q}`, async () => {
      const { store } = await openStore([thread('t1', 'dump', { quad: null })]);
      store.tagTask('t1', q);
      assert.equal(byId(store, 't1').quad, q);
    });
  }
});

// The store keeps its state in memory and saves the WHOLE state on every change, so a failed save is
// retried by the next change. What it must never do is fail silently: the user would think a note was
// kept when it was not. (Found by lane G: the returned promise used to be dropped.)
describe('a failed save', () => {
  const settle = () => new Promise((resolve) => setImmediate(resolve));

  // A store whose saveThreads behaves as `mode` says, one call at a time.
  function storeThatSaves(modes, options) {
    const errors = [];
    const changes = { count: 0 };
    let call = 0;
    const persistence = {
      loadThreads: async () => null,
      saveThreads: (data) => {
        const mode = modes[Math.min(call++, modes.length - 1)];
        if (mode === 'throws') throw new Error('sync failure');
        if (mode === 'rejects') return Promise.reject(new Error('disk full'));
        return Promise.resolve(true);
      },
    };
    const store = createItemStore(persistence, () => { changes.count += 1; },
      options === undefined ? { onSaveError: (err) => errors.push(err.message) } : options);
    return { store, errors, changes };
  }

  it('tells onSaveError, with the error, when the save is rejected', async () => {
    const { store, errors } = storeThatSaves(['rejects']);
    store.addTask('keep me');
    await settle();
    assert.deepEqual(errors, ['disk full']);
  });

  it('tells onSaveError when saveThreads throws instead of returning a promise', async () => {
    const { store, errors } = storeThatSaves(['throws']);
    store.addTask('keep me');
    await settle();
    assert.deepEqual(errors, ['sync failure']);
  });

  it('reports every failed save, not just the first', async () => {
    const { store, errors } = storeThatSaves(['rejects']);
    store.addTask('one');
    store.addTask('two');
    await settle();
    assert.deepEqual(errors, ['disk full', 'disk full']);
  });

  it('keeps the change in memory and still tells the UI when the save fails', async () => {
    const { store, changes } = storeThatSaves(['rejects']);
    const id = store.addTask('keep me');
    await settle();
    assert.equal(byId(store, id).text, 'keep me');
    assert.equal(changes.count, 1);
  });

  it('a failure is not sticky: the next change saves the whole state, earlier change included', async () => {
    const saved = [];
    let fail = true;
    const persistence = {
      loadThreads: async () => null,
      saveThreads: (data) => {
        if (fail) return Promise.reject(new Error('disk full'));
        saved.push(structuredClone(data));
        return Promise.resolve(true);
      },
    };
    const store = createItemStore(persistence, () => {}, { onSaveError: () => {} });
    store.addTask('first, lost to the failure');
    await settle();
    fail = false;
    store.addTask('second');
    await settle();
    assert.deepEqual(saved.at(-1).threads.map((t) => t.text), ['first, lost to the failure', 'second']);
  });

  it('a successful save reports nothing', async () => {
    const { store, errors } = storeThatSaves(['ok']);
    store.addTask('fine');
    await settle();
    assert.deepEqual(errors, []);
  });

  it('with no onSaveError given, a rejected save is not an unhandled rejection', async () => {
    const { store } = storeThatSaves(['rejects'], {});
    const seen = [];
    const listener = (reason) => seen.push(reason);
    process.on('unhandledRejection', listener);
    try {
      store.addTask('keep me');
      await settle();
      await settle();
    } finally {
      process.off('unhandledRejection', listener);
    }
    assert.deepEqual(seen, []);
  });
});
