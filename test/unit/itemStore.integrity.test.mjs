// Integrity guarantees of the item store: ids, deleting, loading, saving and the invariants that
// must hold after any sequence of operations.
//
// Written from the plan alone (docs/NOTES-PLAN.md: the data model, the transitions and the
// "Tightened while we're here" list in section 4, the known issues in section 10, the store
// contract in section 3, the notes on migrate in section 11) BEFORE the implementation was read:
// a second opinion on what "correct" means, so the author of the store is not the only one
// deciding. The only thing taken from the code afterwards is the NAMES of three older operations
// the plan never mentions (recallToDump, reopenTask, toggleFocus); the random test models them
// only by what the plan's invariants demand of them.
//
// Where the plan is silent (what a history entry holds, how a damaged scoreboard is reseeded) a test
// asserts only what any reasonable reading needs, and its name says so.
//
// Public API only. A fixture is either a plain file object or something the store made itself.
// Time is node:test mock timers, so "the same millisecond" and "700 ms later" are exact.

import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createItemStore } from '../../src/core/itemStore.js';

const T0 = 1_700_000_000_000;        // the frozen "now" every test starts at
const BEAT_MS = 700;                 // how long a closing thread stays 'resolving' (plan, section 4)
const STATUSES = ['dump', 'axis', 'resolving', 'done', 'note'];
const EMPTY_STATE = { version: 2, threads: [], stats: { listed: 0, done: 0 }, history: [] };

beforeEach(() => { mock.timers.enable({ apis: ['setTimeout', 'Date'], now: T0 }); });
afterEach(() => { mock.timers.reset(); });

const advance = (ms) => mock.timers.tick(ms);

// ---------------------------------------------------------------- fixtures and small helpers

/** A store on a fake disk that holds `file` (null: no file yet), not yet loaded. */
function newStore(file = null) {
  const saves = [];               // every payload handed to saveThreads, cloned at the moment of the call
  const seen = { renders: 0 };    // how many times the store asked the UI to redraw
  const persistence = {
    async loadThreads() { return structuredClone(file); },
    async saveThreads(payload) { saves.push(structuredClone(payload)); },
  };
  const store = createItemStore(persistence, () => { seen.renders += 1; });
  return { store, saves, seen };
}

/** A store on a fake disk, already loaded. */
async function openStore(file = null) {
  const s = newStore(file);
  await s.store.loadState();
  return s;
}

const itemNamed = (s, text) => {
  const found = s.store.state.threads.find((t) => t.text === text);
  assert.ok(found, `the store has no item with the text "${text}"`);
  return found;
};
const idOf = (s, text) => itemNamed(s, text).id;
const textsOf = (s) => s.store.state.threads.map((t) => t.text).sort();
const lastSaved = (s) => {
  assert.ok(s.saves.length > 0, 'nothing has been saved yet');
  return s.saves.at(-1);
};
/** What a file round trip keeps of a payload (JSON drops undefined, like the real disk does). */
const asOnDisk = (payload) => JSON.parse(JSON.stringify(payload));

/** A new task, tagged and sent to the axis. Returns its id. */
function putOnAxis(s, text, quad = 1) {
  s.store.addTask(text);
  const id = idOf(s, text);
  s.store.tagTask(id, quad);
  s.store.dispatchToAxis(id);
  assert.equal(itemNamed(s, text).status, 'axis', `set-up: "${text}" should be on the axis`);
  return id;
}

/** Close a thread and let the beat run out. */
function closeThread(s, id) {
  s.store.resolveThread(id);
  advance(BEAT_MS);
  assert.equal(s.store.state.threads.find((t) => t.id === id)?.status, 'done', 'set-up: the thread should be done');
}

/** Everything a rejected operation must leave exactly as it was. */
function snapshotOf(s) {
  return { state: structuredClone(s.store.state), saves: s.saves.length, renders: s.seen.renders };
}
function assertUntouched(s, before, what) {
  assert.deepEqual(s.store.state, before.state, `${what} changed the state`);
  assert.equal(s.saves.length, before.saves, `${what} saved`);
  assert.equal(s.seen.renders, before.renders, `${what} asked for a redraw`);
}

/**
 * A realistic file made by the store itself, so no test has to guess the shape of a history entry:
 * one finished thread (with its history entry), one thread on the axis, one plain task in the dump.
 */
async function aFileWithOneFinishedThread() {
  const s = await openStore();
  const finished = putOnAxis(s, 'finished', 1);
  putOnAxis(s, 'still open', 2);
  s.store.addTask('waiting in the dump');
  closeThread(s, finished);
  return asOnDisk(lastSaved(s));
}

// ---------------------------------------------------------------- a tiny seeded random generator

/** mulberry32: small, dependency free, the same sequence for the same seed on every machine. */
function makeRng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    chance: (p) => next() < p,
    pick: (list) => list[Math.floor(next() * list.length)],
  };
}

// ---------------------------------------------------------------- ids (plan section 4 and section 10)

describe('ids', () => {
  const MAKE = {
    task: (s, n) => s.store.addTask(`task ${n}`),
    note: (s, n) => s.store.addNote(`note ${n}`),
  };
  const idsOf = (s) => s.store.state.threads.map((t) => t.id);

  const SAME_MILLISECOND_BATCHES = [
    ['task', 'task'],
    ['note', 'note'],
    ['task', 'note'],
    ['note', 'task'],
    ['task', 'task', 'task'],
    ['note', 'note', 'note', 'note'],
    ['task', 'note', 'task', 'note', 'note', 'task', 'task', 'note'],
  ];
  for (const kinds of SAME_MILLISECOND_BATCHES) {
    it(`items made in the same millisecond (${kinds.join(', ')}) all get different ids`, async () => {
      const s = await openStore();
      kinds.forEach((kind, n) => MAKE[kind](s, n));
      assert.equal(Date.now(), T0, 'set-up: the clock must not have moved');
      const ids = idsOf(s);
      assert.equal(ids.length, kinds.length, 'every call should have made exactly one item');
      assert.equal(new Set(ids).size, ids.length, `duplicate id among ${ids.join(', ')}`);
    });
  }

  it('a burst of 200 items made in one millisecond gets 200 different ids, in memory and on disk', async () => {
    const s = await openStore();
    for (let n = 0; n < 200; n += 1) (n % 3 === 0 ? MAKE.note : MAKE.task)(s, n);
    assert.equal(new Set(idsOf(s)).size, 200);
    assert.equal(new Set(lastSaved(s).threads.map((t) => t.id)).size, 200);
  });

  it('deleting an item does not make the next same-millisecond id collide with a survivor', async () => {
    const s = await openStore();
    for (const text of ['a', 'b', 'c']) s.store.addTask(text);
    s.store.deleteItem(idOf(s, 'a'));
    for (const text of ['d', 'e', 'f']) s.store.addNote(text);
    const ids = idsOf(s);
    assert.equal(ids.length, 5);
    assert.equal(new Set(ids).size, 5, `duplicate id among ${ids.join(', ')}`);
  });

  it('tagging one of several same-millisecond items tags only that one', async () => {
    const s = await openStore();
    for (const text of ['first', 'second', 'third']) s.store.addTask(text);
    s.store.tagTask(idOf(s, 'second'), 3);
    const quads = Object.fromEntries(s.store.state.threads.map((t) => [t.text, t.quad ?? null]));
    assert.deepEqual(quads, { first: null, second: 3, third: null });
  });

  it('deleting one of several same-millisecond tasks and notes removes only that one', async () => {
    const s = await openStore();
    s.store.addTask('first');
    s.store.addNote('second (a note)');
    s.store.addTask('third');
    s.store.addNote('fourth (a note)');
    s.store.deleteItem(idOf(s, 'second (a note)'));
    assert.deepEqual(textsOf(s), ['first', 'fourth (a note)', 'third']);
    s.store.deleteItem(idOf(s, 'third'));
    assert.deepEqual(textsOf(s), ['first', 'fourth (a note)']);
    assert.deepEqual(lastSaved(s).threads.map((t) => t.text).sort(), ['first', 'fourth (a note)']);
  });

  it('closing one of several same-millisecond axis threads completes only that one', async () => {
    const s = await openStore();
    for (const [text, quad] of [['first', 1], ['second', 2], ['third', 3]]) putOnAxis(s, text, quad);
    s.store.resolveThread(idOf(s, 'second'));
    advance(BEAT_MS);
    const statuses = Object.fromEntries(s.store.state.threads.map((t) => [t.text, t.status]));
    assert.deepEqual(statuses, { first: 'axis', second: 'done', third: 'axis' });
    assert.equal(s.store.state.stats.done, 1);
    assert.equal(s.store.state.history.length, 1);
  });

  it('a new id never equals the id of an item loaded from a file made in the same millisecond', async () => {
    const legacyId = T0.toString(36);   // the old id format was Date.now().toString(36) (plan, section 10)
    const s = await openStore({
      version: 2,
      threads: [{ id: legacyId, text: 'from the file', createdAt: T0, status: 'dump', quad: null }],
      stats: { listed: 1, done: 0 },
      history: [],
    });
    s.store.addTask('made now');
    s.store.addNote('a note made now');
    const ids = idsOf(s);
    assert.equal(ids.length, 3);
    assert.equal(new Set(ids).size, 3, `duplicate id among ${ids.join(', ')}`);
  });

  it('an item loaded from a file and one made in the same millisecond can be deleted independently', async () => {
    const s = await openStore({
      version: 2,
      threads: [{ id: T0.toString(36), text: 'from the file', createdAt: T0, status: 'dump', quad: null }],
      stats: { listed: 1, done: 0 },
      history: [],
    });
    s.store.addTask('made now');
    s.store.deleteItem(idOf(s, 'made now'));
    assert.deepEqual(textsOf(s), ['from the file']);
  });

  it('ids made by one session are not handed out again by the next session at the same instant', async () => {
    const earlier = await openStore();
    for (let n = 0; n < 5; n += 1) earlier.store.addTask(`earlier ${n}`);
    const later = await openStore(asOnDisk(lastSaved(earlier)));
    for (let n = 0; n < 5; n += 1) MAKE[n % 2 === 0 ? 'note' : 'task'](later, n);
    const ids = idsOf(later);
    assert.equal(ids.length, 10);
    assert.equal(new Set(ids).size, 10, `duplicate id among ${ids.join(', ')}`);
  });
});

// ---------------------------------------------------------------- deleteItem (plan section 4)

describe('deleteItem', () => {
  it('removes a task, saves the change and asks for a redraw', async () => {
    const s = await openStore();
    s.store.addTask('keep me');
    s.store.addTask('drop me');
    const before = snapshotOf(s);
    s.store.deleteItem(idOf(s, 'drop me'));
    assert.deepEqual(textsOf(s), ['keep me']);
    assert.ok(s.saves.length > before.saves, 'the deletion was not saved');
    assert.deepEqual(lastSaved(s).threads.map((t) => t.text), ['keep me']);
    assert.ok(s.seen.renders > before.renders, 'the deletion asked for no redraw');
  });

  it('removes a note', async () => {
    const s = await openStore();
    s.store.addNote('a note', 'with a body');
    s.store.addTask('a task');
    s.store.deleteItem(idOf(s, 'a note'));
    assert.deepEqual(textsOf(s), ['a task']);
    assert.deepEqual(lastSaved(s).threads.map((t) => t.text), ['a task']);
  });

  it('with an unknown id changes nothing, saves nothing and asks for no redraw (empty store)', async () => {
    const s = await openStore();
    const before = snapshotOf(s);
    s.store.deleteItem('no-such-id');
    assertUntouched(s, before, 'deleting an unknown id');
  });

  it('with an unknown id changes nothing, saves nothing and asks for no redraw (store holding every kind of item)', async () => {
    const s = await openStore();
    s.store.addTask('dump task');
    s.store.addNote('a note', 'body');
    putOnAxis(s, 'axis task', 2);
    closeThread(s, putOnAxis(s, 'done task', 3));
    const before = snapshotOf(s);
    s.store.deleteItem('no-such-id');
    assertUntouched(s, before, 'deleting an unknown id');
  });

  it('never shrinks stats.listed, whatever kind of item goes', async () => {
    const s = await openStore();
    s.store.addTask('dump task');
    putOnAxis(s, 'axis task', 2);
    closeThread(s, putOnAxis(s, 'done task', 3));
    s.store.addNote('a note');
    const listed = s.store.state.stats.listed;
    assert.equal(listed, 3, 'set-up: three tasks were listed and the note was not');
    for (const text of ['dump task', 'axis task', 'done task', 'a note']) {
      s.store.deleteItem(idOf(s, text));
      assert.equal(s.store.state.stats.listed, listed, `deleting "${text}" changed stats.listed`);
      assert.equal(lastSaved(s).stats.listed, listed, `deleting "${text}" saved a different stats.listed`);
    }
    assert.deepEqual(s.store.state.threads, []);
  });

  it('never shrinks stats.done and never removes a history entry, even when the done thread goes', async () => {
    const s = await openStore();
    const first = putOnAxis(s, 'first', 1);
    const second = putOnAxis(s, 'second', 2);
    closeThread(s, first);
    closeThread(s, second);
    const score = structuredClone(s.store.state.stats);
    const history = structuredClone(s.store.state.history);
    assert.equal(score.done, 2, 'set-up: two points');
    assert.equal(history.length, 2, 'set-up: two history entries');
    for (const id of [first, second]) {
      s.store.deleteItem(id);
      assert.deepEqual(s.store.state.stats, score);
      assert.deepEqual(s.store.state.history, history);
      assert.deepEqual(lastSaved(s).stats, score);
      assert.deepEqual(lastSaved(s).history, history);
    }
  });

  describe('on a thread whose close is in flight', () => {
    it('cancels the close: no completion, no score, no history entry and no later save', async () => {
      const s = await openStore();
      const doomed = putOnAxis(s, 'doomed', 1);
      s.store.addTask('bystander');
      const score = structuredClone(s.store.state.stats);
      s.store.resolveThread(doomed);
      advance(300);
      s.store.deleteItem(doomed);
      const savesAtDelete = s.saves.length;
      advance(10_000);
      assert.equal(s.saves.length, savesAtDelete, 'something was saved after the close was cancelled');
      assert.equal(s.store.state.threads.some((t) => t.id === doomed), false, 'the deleted thread came back');
      assert.deepEqual(s.store.state.stats, score, 'the scoreboard moved');
      assert.deepEqual(s.store.state.history, [], 'a history entry appeared');
      assert.deepEqual(lastSaved(s).stats, score);
      assert.deepEqual(lastSaved(s).history, []);
    });

    it('cancels the close when the delete comes in the same instant as the tap', async () => {
      const s = await openStore();
      const doomed = putOnAxis(s, 'doomed', 4);
      s.store.resolveThread(doomed);
      s.store.deleteItem(doomed);
      const savesAtDelete = s.saves.length;
      advance(10_000);
      assert.equal(s.saves.length, savesAtDelete);
      assert.equal(s.store.state.stats.done, 0);
      assert.deepEqual(s.store.state.history, []);
      assert.deepEqual(s.store.state.threads, []);
    });

    it('does not cancel the close of a different thread that is closing at the same time', async () => {
      const s = await openStore();
      const doomed = putOnAxis(s, 'doomed', 1);
      const survivor = putOnAxis(s, 'survivor', 2);
      s.store.resolveThread(doomed);
      s.store.resolveThread(survivor);
      advance(100);
      s.store.deleteItem(doomed);
      advance(BEAT_MS);
      assert.deepEqual(textsOf(s), ['survivor']);
      assert.equal(itemNamed(s, 'survivor').status, 'done');
      assert.equal(s.store.state.stats.done, 1);
      assert.equal(s.store.state.history.length, 1);
    });
  });
});

// ---------------------------------------------------------------- dispatchToAxis needs a quad (plan section 4)

describe('dispatchToAxis', () => {
  it('needs a quad: an untagged item stays in the dump, with nothing saved or redrawn', async () => {
    const s = await openStore();
    s.store.addTask('untagged');
    const before = snapshotOf(s);
    s.store.dispatchToAxis(idOf(s, 'untagged'));
    assertUntouched(s, before, 'dispatching an untagged item');
    assert.equal(itemNamed(s, 'untagged').status, 'dump');
  });

  it('sends a tagged item to the axis', async () => {
    const s = await openStore();
    s.store.addTask('tagged');
    s.store.tagTask(idOf(s, 'tagged'), 2);
    s.store.dispatchToAxis(idOf(s, 'tagged'));
    assert.equal(itemNamed(s, 'tagged').status, 'axis');
    assert.equal(itemNamed(s, 'tagged').quad, 2);
  });
});

// ---------------------------------------------------------------- closing a thread (plan section 4)

describe('closing a thread (resolveThread)', () => {
  it('leaves the thread "resolving" for the 700 ms beat, then makes it done', async () => {
    const s = await openStore();
    const id = putOnAxis(s, 'close me', 1);
    s.store.resolveThread(id);
    assert.equal(itemNamed(s, 'close me').status, 'resolving');
    advance(BEAT_MS - 1);
    assert.equal(itemNamed(s, 'close me').status, 'resolving', 'it finished a millisecond early');
    advance(1);
    assert.equal(itemNamed(s, 'close me').status, 'done');
  });

  it('changes the score and the history only when the beat finishes', async () => {
    const s = await openStore();
    const id = putOnAxis(s, 'close me', 1);
    s.store.resolveThread(id);
    advance(BEAT_MS - 1);
    assert.equal(s.store.state.stats.done, 0);
    assert.equal(s.store.state.history.length, 0);
    advance(1);
    assert.equal(s.store.state.stats.done, 1);
    assert.equal(s.store.state.history.length, 1);
  });

  it('saves, after the beat, status done, a doneAt inside the beat, stats.done + 1 and exactly one new history entry', async () => {
    const s = await openStore();
    const id = putOnAxis(s, 'close me', 1);
    s.store.addTask('another task');
    const before = structuredClone(s.store.state);
    s.store.resolveThread(id);
    advance(BEAT_MS);
    const saved = lastSaved(s);
    const thread = saved.threads.find((t) => t.id === id);
    assert.equal(thread.status, 'done');
    assert.equal(typeof thread.doneAt, 'number', 'doneAt must be a timestamp');
    assert.ok(thread.doneAt >= T0 && thread.doneAt <= T0 + BEAT_MS, `doneAt ${thread.doneAt} is not inside the beat`);
    assert.equal(saved.stats.done, before.stats.done + 1);
    assert.equal(saved.history.length, before.history.length + 1);
    assert.equal(saved.stats.listed, before.stats.listed, 'closing a task must not change how many were listed');
  });

  it('leaves one history entry per finished task, and each entry identifies its task (by id or by text)', async () => {
    const s = await openStore();
    const finished = [['alpha', putOnAxis(s, 'alpha', 1)], ['beta', putOnAxis(s, 'beta', 2)]];
    for (const [, id] of finished) closeThread(s, id);
    assert.equal(s.store.state.history.length, 2);
    for (const [text, id] of finished) {
      // exact field values, not substrings: same-millisecond ids can be prefixes of each other
      const mentioning = s.store.state.history.filter((e) => Object.values(e).some((value) => value === id || value === text));
      assert.equal(mentioning.length, 1, `the history should hold exactly one entry for "${text}"`);
    }
  });

  it('never saves the transient "resolving" state on its own', async () => {
    const s = await openStore();
    const id = putOnAxis(s, 'close me', 1);
    s.store.resolveThread(id);
    advance(BEAT_MS - 1);
    advance(1);
    advance(5_000);
    for (const payload of s.saves) {
      for (const t of payload.threads) assert.notEqual(t.status, 'resolving', 'a payload carried a resolving thread');
    }
    assert.equal(lastSaved(s).threads.find((t) => t.id === id).status, 'done');
  });

  it('loses nothing if the app quits inside the beat: the file a mid-beat mutation saved reloads with the thread back on the axis, uncounted', async () => {
    const s = await openStore();
    const id = putOnAxis(s, 'closing', 2);
    s.store.resolveThread(id);
    advance(200);
    s.store.addTask('typed during the beat');     // any mutation saves the whole state
    const fileIfWeQuitNow = asOnDisk(lastSaved(s));
    const revived = await openStore(fileIfWeQuitNow);
    assert.equal(revived.store.state.threads.find((t) => t.id === id).status, 'axis');
    assert.equal(revived.store.state.stats.done, 0);
    assert.deepEqual(revived.store.state.history, []);
  });

  for (const delay of [0, 1, 300, 699]) {
    it(`a second tap ${delay} ms into the beat does not count the point twice`, async () => {
      const s = await openStore();
      const id = putOnAxis(s, 'close me', 1);
      s.store.resolveThread(id);
      advance(delay);
      s.store.resolveThread(id);
      advance(BEAT_MS);          // long enough for a second, restarted beat to be over as well
      advance(5_000);
      assert.equal(itemNamed(s, 'close me').status, 'done');
      assert.equal(s.store.state.stats.done, 1, 'the point was counted more than once');
      assert.equal(s.store.state.history.length, 1, 'more than one history entry');
      assert.equal(lastSaved(s).stats.done, 1);
      assert.equal(lastSaved(s).history.length, 1);
    });
  }

  const CANNOT_BE_CLOSED = {
    'an untagged task in the dump': (s) => { s.store.addTask('x'); return idOf(s, 'x'); },
    'a tagged task in the dump': (s) => { s.store.addTask('x'); s.store.tagTask(idOf(s, 'x'), 3); return idOf(s, 'x'); },
    'a note': (s) => { s.store.addNote('x', 'body'); return idOf(s, 'x'); },
    'a thread that is already done': (s) => { const id = putOnAxis(s, 'x', 1); closeThread(s, id); return id; },
    'an id nobody has': () => 'no-such-id',
  };
  for (const [what, make] of Object.entries(CANNOT_BE_CLOSED)) {
    it(`does nothing to ${what}: no change, no save, no redraw, and no beat left running`, async () => {
      const s = await openStore();
      const id = make(s);
      const before = snapshotOf(s);
      s.store.resolveThread(id);
      assertUntouched(s, before, 'closing it');
      advance(10_000);
      assertUntouched(s, before, 'the clock running on after closing it');
    });
  }
});

// ---------------------------------------------------------------- loadState (plan sections 4 and 10, integration notes)

/** What a version-1 file looks like: no version field, and none of the fields added in version 2. */
function asVersion1(file) {
  const old = structuredClone(file);
  delete old.version;
  for (const t of old.threads) delete t.updatedAt;
  return old;
}

describe('loadState', () => {
  describe('a version-1 file (no version field, no notes)', () => {
    it('loads as version 2 with every thread, the scoreboard and the history intact', async () => {
      const v1 = asVersion1(await aFileWithOneFinishedThread());
      assert.equal(v1.version, undefined, 'set-up: no version field');
      const s = await openStore(v1);
      assert.equal(s.store.state.version, 2);
      assert.deepEqual(s.store.state.threads, v1.threads);
      assert.deepEqual(s.store.state.stats, v1.stats);
      assert.deepEqual(s.store.state.history, v1.history);
    });

    it('given threads only, still loads every thread as version 2 with a usable scoreboard and history', async () => {
      const threadsOnly = { threads: asVersion1(await aFileWithOneFinishedThread()).threads };
      const s = await openStore(threadsOnly);
      const { version, threads, stats, history } = s.store.state;
      assert.equal(version, 2);
      assert.deepEqual(threads, threadsOnly.threads);
      assert.ok(Array.isArray(history), 'history must be a list');
      for (const key of ['listed', 'done']) {
        assert.ok(Number.isInteger(stats[key]) && stats[key] >= 0, `stats.${key} must be a whole number, got ${stats[key]}`);
      }
      assert.equal(stats.done, history.length, 'the score must agree with the history');
      assert.ok(stats.done <= stats.listed, 'more points than tasks listed');
    });

    it('given threads only, seeds one history entry and one point per done thread, and counts every task as listed (plan: toHistory is shared by itemStore and migrate)', async () => {
      const threadsOnly = { threads: asVersion1(await aFileWithOneFinishedThread()).threads };
      const doneThreads = threadsOnly.threads.filter((t) => t.status === 'done').length;
      assert.equal(doneThreads, 1, 'set-up: one finished thread');
      const s = await openStore(threadsOnly);
      assert.equal(s.store.state.history.length, doneThreads);
      assert.equal(s.store.state.stats.done, doneThreads);
      assert.ok(s.store.state.stats.listed >= threadsOnly.threads.length, 'every task in the file was listed once');
    });
  });

  describe('a thread saved as "resolving" (the app quit inside the beat)', () => {
    /** A real file made by the store, with its axis thread then hand-edited into the state a quit leaves behind. */
    async function aFileSavedMidClose() {
      const file = await aFileWithOneFinishedThread();
      const closing = file.threads.find((t) => t.text === 'still open');
      Object.assign(closing, { status: 'resolving', focused: true, body: 'notes about it' });
      return { file, closing };
    }

    it('comes back on the axis', async () => {
      const { file, closing } = await aFileSavedMidClose();
      const s = await openStore(file);
      assert.equal(s.store.state.threads.find((t) => t.id === closing.id).status, 'axis');
    });

    it('keeps every other field, including focused', async () => {
      const { file, closing } = await aFileSavedMidClose();
      const s = await openStore(file);
      assert.deepEqual(s.store.state.threads.find((t) => t.id === closing.id), { ...closing, status: 'axis' });
    });

    it('leaves the other threads alone', async () => {
      const { file, closing } = await aFileSavedMidClose();
      const s = await openStore(file);
      const others = (list) => list.filter((t) => t.id !== closing.id);
      assert.deepEqual(others(s.store.state.threads), others(file.threads));
    });

    it('counts nothing: the scoreboard and the history are exactly what the file had', async () => {
      const { file } = await aFileSavedMidClose();
      const s = await openStore(file);
      assert.deepEqual(s.store.state.stats, file.stats);
      assert.deepEqual(s.store.state.history, file.history);
    });

    it('writes nothing while loading and starts nothing that could count it later', async () => {
      const { file } = await aFileSavedMidClose();
      const s = await openStore(file);
      assert.equal(s.saves.length, 0, 'loading saved something');
      const loaded = structuredClone(s.store.state);
      advance(10_000);
      assert.equal(s.saves.length, 0, 'something was saved after the clock ran on');
      assert.deepEqual(s.store.state, loaded, 'the state moved after the clock ran on');
    });

    it('is an ordinary axis thread afterwards: closing it counts exactly one point', async () => {
      const { file, closing } = await aFileSavedMidClose();
      const s = await openStore(file);
      s.store.resolveThread(closing.id);
      advance(BEAT_MS);
      assert.equal(s.store.state.threads.find((t) => t.id === closing.id).status, 'done');
      assert.equal(s.store.state.stats.done, file.stats.done + 1);
      assert.equal(s.store.state.history.length, file.history.length + 1);
    });

    it('is put back on the axis in a version-1 file as well (migrate first, then revert)', async () => {
      const { file, closing } = await aFileSavedMidClose();
      const s = await openStore(asVersion1(file));
      assert.equal(s.store.state.version, 2);
      assert.equal(s.store.state.threads.find((t) => t.id === closing.id).status, 'axis');
    });

    it('is done for every resolving thread in the file, not just the first', async () => {
      const file = {
        version: 2,
        threads: [
          { id: 'r1', text: 'one', createdAt: T0 - 3, status: 'resolving', quad: 1, focused: true },
          { id: 'r2', text: 'two', createdAt: T0 - 2, status: 'resolving', quad: 2 },
          { id: 'r3', text: 'three', createdAt: T0 - 1, status: 'resolving', quad: 3 },
        ],
        stats: { listed: 3, done: 0 },
        history: [],
      };
      const s = await openStore(file);
      assert.deepEqual(s.store.state.threads.map((t) => t.status), ['axis', 'axis', 'axis']);
      assert.equal(s.store.state.threads[0].focused, true);
    });
  });

  describe('a file written by a newer app', () => {
    const fromNewerApp = () => ({
      version: 2,
      threads: [
        { id: 'n1', text: 'a task', createdAt: T0 - 1000, status: 'dump', quad: null },
        { id: 'n2', text: 'an open one', createdAt: T0 - 900, status: 'axis', quad: 1 },
      ],
      stats: { listed: 2, done: 0 },
      history: [],
      syncCursor: 'abc123',
      prefs: { theme: 'dark', pinned: [1, 2, 3] },
    });
    const UNKNOWN = { syncCursor: 'abc123', prefs: { theme: 'dark', pinned: [1, 2, 3] } };
    const unknownFieldsOf = (payload) => ({ syncCursor: payload.syncCursor, prefs: payload.prefs });

    it('keeps unknown top-level fields on the loaded state', async () => {
      const s = await openStore(fromNewerApp());
      assert.deepEqual(unknownFieldsOf(s.store.state), UNKNOWN);
    });

    it('writes unknown top-level fields back on a later save', async () => {
      const s = await openStore(fromNewerApp());
      s.store.addTask('typed on the older app');
      assert.deepEqual(unknownFieldsOf(lastSaved(s)), UNKNOWN);
    });

    it('writes them back on the save that finishes a close, too', async () => {
      const s = await openStore(fromNewerApp());
      s.store.resolveThread('n2');
      advance(BEAT_MS);
      assert.equal(lastSaved(s).threads.find((t) => t.id === 'n2').status, 'done');
      assert.deepEqual(unknownFieldsOf(lastSaved(s)), UNKNOWN);
    });

    it('does not downgrade a version above 2 when it saves', async () => {
      const s = await openStore({ ...fromNewerApp(), version: 3 });
      assert.equal(s.store.state.version, 3);
      s.store.addTask('typed on the older app');
      assert.equal(lastSaved(s).version, 3);
    });
  });

  describe('a scoreboard the file does not fully provide', () => {
    it('reseeds a missing stats.done from what the file itself holds', async () => {
      const file = await aFileWithOneFinishedThread();
      delete file.stats.done;
      const s = await openStore(file);
      assert.equal(s.store.state.stats.done, 1, 'one finished thread and one history entry make one point');
      assert.equal(s.store.state.history.length, 1);
    });

    it('reseeds a missing stats.listed to at least the number of tasks the file holds', async () => {
      const file = await aFileWithOneFinishedThread();
      delete file.stats.listed;
      const s = await openStore(file);
      const { listed, done } = s.store.state.stats;
      assert.ok(Number.isInteger(listed), `stats.listed must be a whole number, got ${listed}`);
      assert.ok(listed >= file.threads.length, `${listed} listed for ${file.threads.length} tasks in the file`);
      assert.equal(done, 1, 'the point that was there must stay');
    });

    it('reseeds a file with no scoreboard at all so that it agrees with its history', async () => {
      const file = await aFileWithOneFinishedThread();
      delete file.stats;
      const s = await openStore(file);
      const { listed, done } = s.store.state.stats;
      assert.ok(Number.isInteger(listed) && Number.isInteger(done), `got ${JSON.stringify(s.store.state.stats)}`);
      assert.equal(done, s.store.state.history.length);
      assert.ok(done <= listed);
    });

    it('does not trust scoreboard values that are not numbers', async () => {
      const file = await aFileWithOneFinishedThread();
      file.stats = { listed: 'many', done: null };
      const s = await openStore(file);
      const { listed, done } = s.store.state.stats;
      assert.ok(Number.isInteger(listed) && Number.isInteger(done), `got ${JSON.stringify(s.store.state.stats)}`);
      assert.equal(done, s.store.state.history.length);
    });

    it('lets a close after a reseed count exactly one more point (no NaN)', async () => {
      const s = await openStore({
        version: 2,
        threads: [
          { id: 'open', text: 'open', createdAt: T0 - 2, status: 'axis', quad: 1 },
          { id: 'dump', text: 'dump', createdAt: T0 - 1, status: 'dump', quad: null },
        ],
        stats: { listed: 2 },            // no "done"
        history: [],
      });
      s.store.resolveThread('open');
      advance(BEAT_MS);
      assert.equal(s.store.state.stats.done, 1);
      assert.equal(lastSaved(s).stats.done, 1);
    });

    it('lets a new task after a reseed count exactly one more listed (no NaN)', async () => {
      const s = await openStore({
        version: 2,
        threads: [{ id: 'dump', text: 'dump', createdAt: T0 - 1, status: 'dump', quad: null }],
        stats: { done: 0 },              // no "listed"
        history: [],
      });
      const seeded = s.store.state.stats.listed;
      assert.ok(Number.isInteger(seeded), `stats.listed must be a whole number, got ${seeded}`);
      s.store.addTask('one more');
      assert.equal(s.store.state.stats.listed, seeded + 1);
    });
  });

  describe('a file that is not a state', () => {
    const GARBAGE = [
      ['null (no file yet)', null],
      ['an empty list', []],
      ['a bare list of items (not the {threads: [...]} shape)', [{ id: 'a', text: 'orphan', createdAt: T0, status: 'dump', quad: null }]],
      ['a bare string', 'x'],
      ['an object whose threads is not a list', { threads: 'x' }],
      ['an object whose threads is not a list, whatever scoreboard and history it carries',
        { version: 2, threads: 'x', stats: { listed: 9, done: 9 }, history: [{ id: 'h', text: 'ghost' }] }],
    ];
    for (const [what, file] of GARBAGE) {
      it(`${what} loads as the empty version-2 state`, async () => {
        const s = await openStore(file);
        assert.deepEqual(s.store.state, EMPTY_STATE);
      });
    }
  });

  describe('the live state object', () => {
    it('keeps its identity: loadState fills in the same store.state, it does not replace it', async () => {
      const s = newStore(await aFileWithOneFinishedThread());
      const live = s.store.state;
      await s.store.loadState();
      assert.equal(s.store.state, live);
      assert.equal(live.threads.length, 3, 'the object everyone already holds must contain the loaded threads');
    });

    it('keeps its identity when the file is garbage, too', async () => {
      const s = newStore('x');
      const live = s.store.state;
      await s.store.loadState();
      assert.equal(s.store.state, live);
      assert.deepEqual(live, EMPTY_STATE);
    });
  });
});

// ---------------------------------------------------------------- persistence round trip

describe('persistence round trip', () => {
  it('the last saved payload, loaded by a fresh store, reproduces the live state exactly', async () => {
    const s = await openStore();
    s.store.addTask('plain task in the dump');
    advance(1_000);
    s.store.addTask('tagged task in the dump');
    s.store.tagTask(idOf(s, 'tagged task in the dump'), 4);
    advance(1_000);
    putOnAxis(s, 'task on the axis', 2);
    advance(1_000);
    closeThread(s, putOnAxis(s, 'finished task', 1));
    advance(1_000);
    s.store.addTask('task with a body', 'the body of the task');
    advance(1_000);
    const url = 'https://example.com/read-me';
    s.store.addNote(url, 'why it matters\nsecond line');
    s.store.setLinkTitle(idOf(s, url), url, 'Read Me');
    advance(1_000);

    // The set-up must really have made each kind of thing, or the comparison below proves nothing.
    assert.deepEqual(s.store.state.threads.map((t) => t.status).sort(), ['axis', 'done', 'dump', 'dump', 'dump', 'note']);
    assert.equal(itemNamed(s, url).body, 'why it matters\nsecond line');
    assert.equal(itemNamed(s, url).linkTitle, 'Read Me');
    assert.equal(itemNamed(s, 'task with a body').body, 'the body of the task');
    assert.equal(s.store.state.history.length, 1);

    const fresh = await openStore(asOnDisk(lastSaved(s)));
    assert.deepEqual(fresh.store.state, s.store.state);
    assert.equal(fresh.saves.length, 0, 'loading saved something');
  });

  it('the state a fresh store reloads is itself stable: saving after the reload and reloading again changes nothing', async () => {
    const first = await openStore();
    closeThread(first, putOnAxis(first, 'finished task', 1));
    first.store.addNote('a note', 'its body');
    const second = await openStore(asOnDisk(lastSaved(first)));
    second.store.addTask('one more');                      // makes the reloaded store save
    const third = await openStore(asOnDisk(lastSaved(second)));
    assert.deepEqual(third.store.state, second.store.state);
  });
});

// ---------------------------------------------------------------- invariants under random operation sequences
//
// Every public operation except loadState is drawn at random, on existing, stale and unknown ids,
// with the clock mostly standing still (same-millisecond ids) and sometimes running past the 700 ms beat.
// After EVERY operation the store is checked against the plan's invariants and against a model
// that I keep myself, from the operations I perform and the clock alone.

const OPERATIONS = [                       // a weighted menu: the busy middle of the pipeline gets the most turns
  'addTask', 'addTask', 'addTask', 'addNote',
  'tagTask', 'tagTask', 'tagTask',
  'dispatchToAxis', 'dispatchToAxis', 'dispatchToAxis', 'dispatchToAxis',
  'resolveThread', 'resolveThread', 'resolveThread', 'resolveThread', 'resolveThread',
  'deleteItem', 'deleteItem',
  'fileAsNote', 'unfileNote',
  'recallToDump', 'recallToDump', 'reopenTask', 'reopenTask', 'toggleFocus', 'toggleFocus',
  'setBody', 'setText', 'setLinkTitle',
];
const CANNOT_BE_REJECTED = ['addTask', 'addNote'];
const TEXTS = ['alpha', 'beta', 'gamma', 'delta', 'https://example.com/a', 'https://example.com/b'];
const BODIES = ['a body', 'two\nlines', 'a body with a link https://example.com/c'];
const CLOCK_JUMPS = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 7, 100, 300, 699, 700, 701, 1_500, 5_000];   // mostly frozen
const UNKNOWN_IDS = ['no-such-id', 'ghost', ''];
const SEEDS = Array.from({ length: 40 }, (_, i) => i + 1);
const STEPS = 60;

/** What the store should hold, kept from the operations performed and the clock, never read back from the store. */
function newModel() {
  return {
    now: T0,
    status: new Map(),      // id -> the status the item should have
    closesAt: new Map(),    // id -> the moment its 700 ms beat ends
    deleted: [],            // ids that used to exist (they make good "stale" ids)
    adds: 0,                // addTask calls
    filed: 0,               // fileAsNote calls that worked
    unfiled: 0,             // unfileNote calls that worked
    completions: 0,         // closes whose beat ran out with the thread still there, less the ones reopened
    // How often a run reached the awkward moments. Only used to prove the generator gets there.
    reached: { sameMillisecondCreations: 0, tapsOnClosingThreads: 0, deletesOfClosingThreads: 0, closesFinished: 0 },
    lastCreatedAt: null,
    closing: null,          // the thread whose close was started most recently
    created() {
      if (this.lastCreatedAt === this.now) this.reached.sameMillisecondCreations += 1;
      this.lastCreatedAt = this.now;
    },
    runClock(ms) {
      this.now += ms;
      for (const [id, due] of [...this.closesAt]) {
        if (due > this.now) continue;
        this.closesAt.delete(id);
        this.status.set(id, 'done');
        this.completions += 1;
        this.reached.closesFinished += 1;
      }
    },
  };
}

const inStatus = (model, ...statuses) => (id) => statuses.includes(model.status.get(id));

/**
 * An id to aim an operation at. `fits` says which items the operation can work on and `tempting`
 * which invalid targets are worth probing (a second tap on a closing thread, a dispatch of a done
 * one...). Otherwise any existing id, or a stranger: an id nobody has, or one that was deleted.
 */
function chooseId(rng, model, fits, tempting = () => false, temptingChance = 0.25) {
  const existing = [...model.status.keys()];
  const fitting = existing.filter(fits);
  const probing = existing.filter(tempting);
  if (probing.length > 0 && rng.chance(temptingChance)) return rng.pick(probing);
  if (fitting.length > 0 && rng.chance(0.75)) return rng.pick(fitting);
  if (existing.length > 0 && rng.chance(0.7)) return rng.pick(existing);
  return rng.pick([...UNKNOWN_IDS, ...model.deleted]);
}

function newIdSince(s, knownIds) {
  const added = s.store.state.threads.filter((t) => !knownIds.has(t.id));
  assert.equal(added.length, 1, `the call should have added exactly one item, it added ${added.length}`);
  return added[0].id;
}
const idsNow = (s) => new Set(s.store.state.threads.map((t) => t.id));
const ANY_STATUS = ['dump', 'axis', 'resolving', 'done', 'note'];
const hasQuad = (s, id) => s.store.state.threads.find((t) => t.id === id)?.quad != null;

/**
 * The public operations. `fits` says which items an operation can work on and `tempting` which
 * invalid targets are worth probing; `run` makes the call, updates the model, and returns true when
 * the plan makes the call a no-op (an unknown id, or a move the plan does not allow from that status).
 */
const CALLS = {
  addTask: {
    run(rng, s, m) {
      const known = idsNow(s);
      const text = rng.pick(TEXTS);
      if (rng.chance(0.3)) s.store.addTask(text, rng.pick(BODIES)); else s.store.addTask(text);
      m.status.set(newIdSince(s, known), 'dump');
      m.adds += 1;
      m.created();
      return false;
    },
  },
  addNote: {
    run(rng, s, m) {
      const known = idsNow(s);
      const text = rng.pick(TEXTS);
      if (rng.chance(0.5)) s.store.addNote(text, rng.pick(BODIES)); else s.store.addNote(text);
      m.status.set(newIdSince(s, known), 'note');
      m.created();
      return false;
    },
  },
  tagTask: {
    fits: (m) => inStatus(m, 'dump'),
    tempting: (m) => inStatus(m, 'axis', 'note'),
    run(rng, s, m, id) {
      s.store.tagTask(id, rng.pick([1, 2, 3, 4]));
      return !m.status.has(id) || m.status.get(id) === 'note';
    },
  },
  dispatchToAxis: {
    fits: (m, s) => (id) => m.status.get(id) === 'dump' && hasQuad(s, id),
    tempting: (m) => inStatus(m, 'dump', 'axis', 'resolving', 'done', 'note'),
    run(rng, s, m, id) {
      const allowed = m.status.get(id) === 'dump' && hasQuad(s, id);       // from the dump, and only with a quad
      s.store.dispatchToAxis(id);
      if (allowed) m.status.set(id, 'axis');
      return !allowed;
    },
  },
  resolveThread: {
    fits: (m) => inStatus(m, 'axis'),
    tempting: (m) => inStatus(m, 'resolving'),                              // the second tap
    temptingChance: 0.5,
    run(rng, s, m, id) {
      const allowed = m.status.get(id) === 'axis';                          // only an axis thread
      if (m.status.get(id) === 'resolving') m.reached.tapsOnClosingThreads += 1;
      s.store.resolveThread(id);
      if (allowed) {
        m.status.set(id, 'resolving');
        m.closesAt.set(id, m.now + BEAT_MS);
        m.closing = id;
      }
      return !allowed;
    },
  },
  deleteItem: {
    fits: (m) => inStatus(m, ...ANY_STATUS),
    tempting: (m) => inStatus(m, 'resolving'),
    temptingChance: 0.5,
    run(rng, s, m, id) {
      const known = m.status.has(id);
      if (m.status.get(id) === 'resolving') m.reached.deletesOfClosingThreads += 1;
      s.store.deleteItem(id);
      if (known) {
        m.status.delete(id);
        m.closesAt.delete(id);                                              // deleting cancels a close in flight
        m.deleted.push(id);
      }
      return !known;
    },
  },
  fileAsNote: {
    fits: (m) => inStatus(m, 'dump'),
    tempting: (m) => inStatus(m, 'axis', 'resolving', 'done', 'note'),
    run(rng, s, m, id) {
      const allowed = m.status.get(id) === 'dump';
      s.store.fileAsNote(id);
      if (allowed) {
        m.status.set(id, 'note');
        m.filed += 1;
      }
      return !allowed;
    },
  },
  unfileNote: {
    fits: (m) => inStatus(m, 'note'),
    tempting: (m) => inStatus(m, 'dump', 'axis', 'resolving', 'done'),
    run(rng, s, m, id) {
      const allowed = m.status.get(id) === 'note';
      s.store.unfileNote(id);
      if (allowed) {
        m.status.set(id, 'dump');
        m.unfiled += 1;
      }
      return !allowed;
    },
  },
  // The plan does not list these three older operations, so what is modelled here is only what their
  // names and the plan's invariants say: recall moves an axis thread back to the dump; reopen takes a
  // done thread out of "done" and gives the point (and its history entry) back; focus is for axis threads.
  recallToDump: {
    fits: (m) => inStatus(m, 'axis'),
    tempting: (m) => inStatus(m, 'resolving', 'done', 'dump', 'note'),
    run(rng, s, m, id) {
      const allowed = m.status.get(id) === 'axis';
      s.store.recallToDump(id);
      if (allowed) m.status.set(id, 'dump');
      return !allowed;
    },
  },
  reopenTask: {
    fits: (m) => inStatus(m, 'done'),
    tempting: (m) => inStatus(m, 'axis', 'resolving', 'dump', 'note'),
    run(rng, s, m, id) {
      const allowed = m.status.get(id) === 'done';
      s.store.reopenTask(id);
      if (allowed) {
        const now = s.store.state.threads.find((t) => t.id === id)?.status;
        assert.ok(['axis', 'dump'].includes(now), `a reopened thread should be back in play, its status is ${now}`);
        m.status.set(id, now);
        m.completions -= 1;
      }
      return !allowed;
    },
  },
  toggleFocus: {
    fits: (m) => inStatus(m, 'axis'),
    tempting: (m) => inStatus(m, 'dump', 'note', 'done', 'resolving'),
    run(rng, s, m, id) {
      const status = m.status.get(id);
      s.store.toggleFocus(id);
      return status === undefined || status === 'dump' || status === 'note' || status === 'done';
    },
  },
  setBody: {
    fits: (m) => inStatus(m, 'dump', 'axis', 'done', 'note'),
    tempting: (m) => inStatus(m, 'resolving'),
    run(rng, s, m, id) {
      const status = m.status.get(id);
      s.store.setBody(id, rng.pick(['', 'text', 'a\nb', 'trailing space   ']));
      return status === undefined || status === 'resolving';                // any but resolving
    },
  },
  setText: {
    fits: (m) => inStatus(m, 'dump', 'axis', 'note'),
    tempting: (m) => inStatus(m, 'resolving', 'done'),
    run(rng, s, m, id) {
      const status = m.status.get(id);
      const text = rng.pick(['', 'renamed', 'https://example.com/renamed']);
      s.store.setText(id, text);
      return status === undefined || status === 'resolving' || status === 'done' || text === '';
    },
  },
  setLinkTitle: {
    fits: (m) => inStatus(m, ...ANY_STATUS),
    run(rng, s, m, id) {
      const item = s.store.state.threads.find((t) => t.id === id);
      const url = item && rng.chance(0.6) ? item.text.trim() : 'https://elsewhere.example/';
      s.store.setLinkTitle(id, url, 'A Title');
      return !item || item.text.trim() !== url;                              // only while the text is still exactly the url
    },
  },
};

/**
 * Pick an operation, aim it and run it. Mostly an operation that has something valid to work on
 * right now; and right after a close starts, usually a probe of that very thread (a second tap, a
 * delete, or a move the plan does not allow while it is closing).
 */
const PROBES_OF_A_CLOSING_THREAD = [
  'resolveThread', 'resolveThread', 'resolveThread', 'deleteItem', 'deleteItem', 'deleteItem',
  'tagTask', 'dispatchToAxis', 'fileAsNote', 'setBody', 'setText',
];
function performRandomCall(rng, s, m) {
  if (m.closing !== null && m.status.get(m.closing) === 'resolving' && rng.chance(0.75)) {
    const name = rng.pick(PROBES_OF_A_CLOSING_THREAD);
    const id = m.closing;
    m.closing = null;
    return { name, rejected: CALLS[name].run(rng, s, m, id) };
  }
  const workable = OPERATIONS.filter((name) => {
    const { fits } = CALLS[name];
    return !fits || [...m.status.keys()].some(fits(m, s));
  });
  const name = workable.length > 0 && rng.chance(0.8) ? rng.pick(workable) : rng.pick(OPERATIONS);
  const call = CALLS[name];
  const id = call.fits ? chooseId(rng, m, call.fits(m, s), call.tempting?.(m, s), call.temptingChance) : undefined;
  return { name, rejected: call.run(rng, s, m, id) };
}

/** The plan's invariants, plus agreement with the model. */
function assertInvariants(s, m, where) {
  const { threads, stats, history } = s.store.state;
  const ids = threads.map((t) => t.id);
  assert.equal(new Set(ids).size, ids.length, `${where}: ids are not unique (${ids.join(', ')})`);

  for (const t of threads) {
    assert.ok(STATUSES.includes(t.status), `${where}: "${t.text}" has the status ${t.status}`);
    if (t.status === 'note') assert.equal(t.quad ?? null, null, `${where}: the note "${t.text}" has a quad`);
    if (t.status === 'axis') assert.ok([1, 2, 3, 4].includes(t.quad), `${where}: the axis thread "${t.text}" has no quad`);
  }
  // At most one thread is focused, and only one that is on the axis. (A thread mid-close is still on
  // the axis, crossed off: the plan's own "saved as resolving" file keeps its focused flag.)
  const focused = threads.filter((t) => t.focused);
  assert.ok(focused.length <= 1, `${where}: ${focused.length} threads are focused`);
  for (const t of focused) {
    assert.ok(['axis', 'resolving'].includes(t.status), `${where}: "${t.text}" is focused but its status is ${t.status}`);
  }

  assert.equal(stats.done, history.length, `${where}: stats.done is ${stats.done} but the history has ${history.length} entries`);
  assert.ok(stats.listed >= 0, `${where}: stats.listed is ${stats.listed}`);

  assert.deepEqual([...ids].sort(), [...m.status.keys()].sort(), `${where}: the store holds different items than my bookkeeping expects`);
  for (const t of threads) {
    assert.equal(t.status, m.status.get(t.id), `${where}: "${t.text}" is ${t.status}, my bookkeeping says ${m.status.get(t.id)}`);
  }
  const expectedListed = m.adds - m.filed + m.unfiled;
  assert.equal(stats.listed, expectedListed, `${where}: stats.listed is ${stats.listed}, addTask calls - fileAsNote + unfileNote is ${expectedListed}`);
  assert.equal(stats.done, m.completions, `${where}: stats.done is ${stats.done}, closes that finished is ${m.completions}`);
}

/** With no close in flight, the last save alone must be enough to get the live state back. */
async function assertLastSaveReproducesState(s, where) {
  if (s.saves.length === 0) return assert.deepEqual(s.store.state, EMPTY_STATE, `${where}: nothing saved, yet the state is not the empty one`);
  const reloaded = await openStore(asOnDisk(lastSaved(s)));
  return assert.deepEqual(reloaded.store.state, s.store.state, `${where}: the last saved payload does not reload as the live state`);
}

async function runRandomSession(seed) {
  const rng = makeRng(seed);
  const s = await openStore();
  const m = newModel();
  const tally = {};
  const statusesSeen = new Set();
  for (let step = 1; step <= STEPS; step += 1) {
    const jump = rng.pick(CLOCK_JUMPS);
    advance(jump);
    m.runClock(jump);
    const before = snapshotOf(s);
    const { name, rejected } = performRandomCall(rng, s, m);
    const where = `seed ${seed}, step ${step}, ${name}`;
    if (rejected) assertUntouched(s, before, `${where}: a call the plan makes a no-op`);
    assertInvariants(s, m, where);
    if (m.closesAt.size === 0) await assertLastSaveReproducesState(s, where);
    tally[name] ??= { accepted: 0, rejected: 0 };
    tally[name][rejected ? 'rejected' : 'accepted'] += 1;
    for (const t of s.store.state.threads) statusesSeen.add(t.status);
  }
  advance(10_000);                                  // every beat still running is over now
  m.runClock(10_000);
  assert.equal(m.closesAt.size, 0);
  assertInvariants(s, m, `seed ${seed}, after the clock ran on`);
  await assertLastSaveReproducesState(s, `seed ${seed}, after the clock ran on`);
  return { tally, statusesSeen, reached: m.reached };
}

describe('invariants under random operation sequences', () => {
  for (const seed of SEEDS) {
    it(`seed ${seed}: ${STEPS} random operations keep every invariant and the store agrees with my bookkeeping`, async () => {
      await runRandomSession(seed);
    });
  }

  it('the generator reaches every operation, accepted and rejected, every status and the awkward moments', async () => {
    const total = {};
    const statuses = new Set();
    const reached = { sameMillisecondCreations: 0, tapsOnClosingThreads: 0, deletesOfClosingThreads: 0, closesFinished: 0 };
    for (const seed of SEEDS) {
      const run = await runRandomSession(seed);
      for (const [name, counts] of Object.entries(run.tally)) {
        total[name] ??= { accepted: 0, rejected: 0 };
        total[name].accepted += counts.accepted;
        total[name].rejected += counts.rejected;
      }
      for (const status of run.statusesSeen) statuses.add(status);
      for (const key of Object.keys(reached)) reached[key] += run.reached[key];
    }
    for (const name of new Set(OPERATIONS)) {
      assert.ok((total[name]?.accepted ?? 0) >= 15, `${name} was only exercised on a valid target ${total[name]?.accepted ?? 0} times`);
      if (!CANNOT_BE_REJECTED.includes(name)) {
        assert.ok((total[name]?.rejected ?? 0) >= 5, `${name} was only aimed at an invalid target ${total[name]?.rejected ?? 0} times`);
      }
    }
    assert.deepEqual([...statuses].sort(), [...STATUSES].sort());
    assert.ok(reached.sameMillisecondCreations >= 100, `only ${reached.sameMillisecondCreations} items were made in the same millisecond as another`);
    assert.ok(reached.closesFinished >= 50, `only ${reached.closesFinished} closes ran to the end`);
    assert.ok(reached.tapsOnClosingThreads >= 15, `only ${reached.tapsOnClosingThreads} taps landed on a thread that was already closing`);
    assert.ok(reached.deletesOfClosingThreads >= 15, `only ${reached.deletesOfClosingThreads} deletes landed on a thread that was closing`);
  });
});
