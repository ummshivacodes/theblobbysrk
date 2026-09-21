// The NOTE operations of the item store, checked against the SPECIFICATION, not against the code:
// docs/NOTES-PLAN.md section 1 (what we are building), section 3 "Contracts" and section 4 "Data model v2"
// (transitions table + "Tightened while we're here"). Everything goes through createItemStore's public
// API; fixtures are loaded through loadState with a fake persistence. Ids, delete, load/save and the
// global invariants belong to itemStore.integrity.test.mjs.
//
// Provenance. Section 4's table is terse: it says setBody "trims the end; deletes the key when empty" and
// setText "ignores empty", and its updatedAt comment says "set by every mutation". The finer rules
// tested here (leading whitespace kept, non-string input treated as empty, an identical value being a
// no-op, updatedAt stamped only by the seven note/body/text/link operations so that task rows keep their
// on-disk shape) are the agreed contract for the note operations, not text from that table.
//
// The spec's promise for every guard, and the yardstick used all through this file:
//   an impossible move is a TRUE NO-OP: same state, nothing saved, no re-render.
// and for every accepted move: saved once, announced once.
//
// updatedAt policy (so task rows keep their on-disk shape): stamped ONLY by addNote, addTask (when a
// body is given), fileAsNote, unfileNote, setBody, setText and setLinkTitle. Never by the task
// transitions (tagTask, dispatchToAxis, recallToDump, resolveThread, reopenTask, toggleFocus).

import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createItemStore } from '../../src/core/itemStore.js';

// ---- the clock: the store may only know the time through Date, and the tests own it ----
const T0 = 1_700_000_000_000;      // "now" when a test starts
const EARLIER = T0 - 3_600_000;    // when the fixture rows were created (and last edited)
const LATER = T0 + 90_000;         // "now" after a test moves the clock on
const RESOLVE_WINDOW = 1_000;      // comfortably past the 700 ms a thread spends 'resolving'

beforeEach(() => mock.timers.enable({ apis: ['setTimeout', 'Date'], now: T0 }));
afterEach(() => mock.timers.reset());

const moveClockTo = (t) => mock.timers.tick(t - Date.now());

// ---- fixtures: one small factory per status; every test names the fields it cares about ----
const item = (over) => ({ id: 'a', text: 'a thing to do', createdAt: EARLIER, status: 'dump', quad: null, ...over });
const dump = (over) => item({ status: 'dump', quad: null, ...over });
const tagged = (over) => item({ status: 'dump', quad: 3, ...over });   // tagged in the inbox, not pushed yet
const axis = (over) => item({ status: 'axis', quad: 2, ...over });
const done = (over) => item({ status: 'done', quad: 2, doneAt: EARLIER + 60_000, ...over });
const note = (over) => item({ status: 'note', quad: null, ...over });

// The store starts from a fake disk. Counters are zeroed after loading, so a test only sees what
// its own call caused. `saves` holds a deep copy of every payload handed to persistence.saveThreads;
// `rendered` holds a deep copy of the state at the moment each onChange fired.
async function setup(threads = [], { listed = 5, doneCount = 2, history = [] } = {}) {
  const disk = { version: 2, threads, stats: { listed, done: doneCount }, history };
  const saves = [];
  const rendered = [];
  const persistence = {
    loadThreads: async () => structuredClone(disk),
    saveThreads: async (data) => { saves.push(structuredClone(data)); },
  };
  const store = createItemStore(persistence, () => { rendered.push(structuredClone(store.state)); });
  await store.loadState();
  const h = {
    store,
    saves,
    rendered,
    row: (id = 'a') => store.state.threads.find((t) => t.id === id),
    savedRow: (id = 'a') => saves.at(-1)?.threads.find((t) => t.id === id),
    listed: () => store.state.stats.listed,
    reset() { saves.length = 0; rendered.length = 0; },
  };
  h.reset();
  return h;
}

// A thread can only be 'resolving' for 700 ms after resolveThread, so the fixture is built through
// the API and the clock is left alone (a test that ticks past the window would finish the resolve).
async function setupResolving(over = {}) {
  const h = await setup([axis({ id: 'a', ...over })]);
  h.store.resolveThread('a');
  assert.equal(h.row().status, 'resolving', 'fixture: the thread is mid-resolve');
  h.reset();
  return h;
}

// One fixture per status, all with id 'a'; `over` lands on the row (before it starts resolving).
const ROW_BUILDERS = { dump, axis, done, note };
const STATUSES = ['dump', 'axis', 'resolving', 'done', 'note'];
const setupWithStatus = (status, over = {}) => status === 'resolving'
  ? setupResolving(over)
  : setup([ROW_BUILDERS[status]({ id: 'a', ...over })]);

// An impossible move is a true no-op: same state, nothing saved, no re-render.
function assertNoOp(h, action, what = 'the call') {
  const before = structuredClone(h.store.state);
  action();
  assert.deepEqual(h.store.state, before, `${what} changed the state`);
  assert.equal(h.saves.length, 0, `${what} saved`);
  assert.equal(h.rendered.length, 0, `${what} re-rendered`);
}

// An accepted move is saved once, announced once, what is saved is what the state says, and the
// announcement already sees the new state (the view renders from it).
function assertCommittedOnce(h, action) {
  const result = action();
  assert.equal(h.saves.length, 1, 'saved exactly once');
  assert.equal(h.rendered.length, 1, 'announced (onChange) exactly once');
  assert.deepEqual(h.saves[0].threads, h.store.state.threads, 'the saved rows are the state rows');
  assert.deepEqual(h.saves[0].stats, h.store.state.stats, 'the saved stats are the state stats');
  assert.deepEqual(h.rendered[0], h.store.state, 'onChange fires after the state has changed');
  return result;
}

const a = (word) => `${/^[aeiou]/.test(word) ? 'an' : 'a'} ${word}`;   // "a dump", "an axis": for generated test names
const without = (obj, ...keys) => Object.fromEntries(Object.entries(obj).filter(([k]) => !keys.includes(k)));
const others = (state, id = 'a') => state.threads.filter((t) => t.id !== id);
const has = (obj, key) => Object.hasOwn(obj, key);

describe('addNote(text, body?)', () => {
  it('creates a note: status "note", never tagged', async () => {
    const h = await setup();
    const id = h.store.addNote('call the plumber');
    assert.equal(h.row(id).status, 'note');
    assert.equal(h.row(id).quad, null);
    assert.equal(h.row(id).text, 'call the plumber');
  });

  it('stamps createdAt and updatedAt with the current time', async () => {
    const h = await setup();
    moveClockTo(LATER);
    const id = h.store.addNote('call the plumber');
    assert.equal(h.row(id).createdAt, LATER);
    assert.equal(h.row(id).updatedAt, LATER);
  });

  it('has no body key when no body is given', async () => {
    const h = await setup();
    const id = h.store.addNote('call the plumber');
    assert.equal(has(h.row(id), 'body'), false);
  });

  it('keeps the body when one is given', async () => {
    const h = await setup();
    const id = h.store.addNote('groceries', 'milk\neggs');
    assert.equal(h.row(id).body, 'milk\neggs');
  });

  it('returns the id of the note it created', async () => {
    const h = await setup([dump({ id: 'a' })]);
    const id = h.store.addNote('call the plumber');
    assert.notEqual(id, 'a');
    assert.equal(h.row(id).text, 'call the plumber');
    assert.equal(h.store.state.threads.length, 2);
  });

  it('has exactly the fields of the data model, and no others', async () => {
    const h = await setup();
    const plain = h.store.addNote('call the plumber');
    assert.deepEqual(h.row(plain), { id: plain, text: 'call the plumber', createdAt: T0, status: 'note', quad: null, updatedAt: T0 });
    const withBody = h.store.addNote('groceries', 'milk\neggs');
    assert.deepEqual(h.row(withBody), { id: withBody, text: 'groceries', createdAt: T0, status: 'note', quad: null, body: 'milk\neggs', updatedAt: T0 });
  });

  it('does not count as a listed task: stats.listed stays where it was', async () => {
    const h = await setup([], { listed: 7 });
    h.store.addNote('call the plumber');
    h.store.addNote('groceries', 'milk\neggs');
    assert.equal(h.listed(), 7);
  });

  it('saves once and notifies once', async () => {
    const h = await setup();
    assertCommittedOnce(h, () => h.store.addNote('call the plumber'));
  });

  it('saves once and notifies once when it has a body', async () => {
    const h = await setup();
    assertCommittedOnce(h, () => h.store.addNote('groceries', 'milk\neggs'));
  });

  it('leaves the other rows, stats.done and the history alone', async () => {
    const h = await setup([dump({ id: 'a' }), axis({ id: 'b' }), done({ id: 'c' })], { history: [{ id: 'c' }] });
    const before = structuredClone(h.store.state);
    const id = h.store.addNote('call the plumber');
    assert.deepEqual(others(h.store.state, id), before.threads);
    assert.equal(h.store.state.stats.done, before.stats.done);
    assert.deepEqual(h.store.state.history, before.history);
  });
});

describe('addTask(text, body?)', () => {
  it('without a body the row gets no body and no updatedAt: task rows keep their on-disk shape', async () => {
    const h = await setup();
    const id = h.store.addTask('write the report');
    assert.equal(has(h.row(id), 'body'), false);
    assert.equal(has(h.row(id), 'updatedAt'), false);
    assert.equal(has(h.row(id), 'linkTitle'), false);
  });

  it('with a body the row gets the body and an updatedAt of now', async () => {
    const h = await setup();
    moveClockTo(LATER);
    const id = h.store.addTask('write the report', 'outline:\n- intro\n- numbers');
    assert.equal(h.row(id).body, 'outline:\n- intro\n- numbers');
    assert.equal(h.row(id).updatedAt, LATER);
  });

  it('is still an ordinary dump task: status "dump", untagged, created now', async () => {
    const h = await setup();
    moveClockTo(LATER);
    const id = h.store.addTask('write the report', 'outline');
    assert.equal(h.row(id).status, 'dump');
    assert.equal(h.row(id).quad, null);
    assert.equal(h.row(id).createdAt, LATER);
    assert.equal(h.row(id).text, 'write the report');
  });

  it('still counts the new task in stats.listed (the control for "notes do not")', async () => {
    const h = await setup([], { listed: 7 });
    h.store.addTask('write the report');
    assert.equal(h.listed(), 8);
    h.store.addTask('and another', 'with a body');
    assert.equal(h.listed(), 9);
  });

  it('saves once and notifies once', async () => {
    const h = await setup();
    assertCommittedOnce(h, () => h.store.addTask('write the report'));
  });

  it('saves once and notifies once when it has a body', async () => {
    const h = await setup();
    assertCommittedOnce(h, () => h.store.addTask('write the report', 'outline'));
  });
});

describe('fileAsNote(id): dump -> note', () => {
  it('turns a dump item into a note', async () => {
    const h = await setup([dump({ id: 'a' })]);
    h.store.fileAsNote('a');
    assert.equal(h.row().status, 'note');
  });

  it('clears the tag: a dump that was tagged Q3 comes out untagged', async () => {
    const h = await setup([tagged({ id: 'a', quad: 3 })]);
    h.store.fileAsNote('a');
    assert.equal(h.row().quad, null);
  });

  it('takes one off stats.listed: it was never a task', async () => {
    const h = await setup([dump({ id: 'a' })], { listed: 5 });
    h.store.fileAsNote('a');
    assert.equal(h.listed(), 4);
  });

  it('never takes stats.listed below zero, and still files the item', async () => {
    const h = await setup([dump({ id: 'a' })], { listed: 0 });
    h.store.fileAsNote('a');
    assert.equal(h.listed(), 0);
    assert.equal(h.row().status, 'note');
  });

  it('stamps updatedAt with the current time', async () => {
    const h = await setup([dump({ id: 'a' })]);
    moveClockTo(LATER);
    h.store.fileAsNote('a');
    assert.equal(h.row().updatedAt, LATER);
  });

  it('keeps the text, body, linkTitle and createdAt of the item', async () => {
    const h = await setup([tagged({ id: 'a', text: 'https://example.com/a', body: 'why I saved it', linkTitle: 'Example A' })]);
    const before = structuredClone(h.row());
    h.store.fileAsNote('a');
    assert.deepEqual(without(h.row(), 'status', 'quad', 'updatedAt'), without(before, 'status', 'quad', 'updatedAt'));
  });

  it('saves once and notifies once', async () => {
    const h = await setup([dump({ id: 'a' })]);
    assertCommittedOnce(h, () => h.store.fileAsNote('a'));
  });

  it('changes nothing but this item and stats.listed', async () => {
    const h = await setup([dump({ id: 'a' }), axis({ id: 'b' }), note({ id: 'c' }), done({ id: 'd' })], { history: [{ id: 'd' }] });
    const before = structuredClone(h.store.state);
    h.store.fileAsNote('a');
    assert.deepEqual(others(h.store.state), others(before));
    assert.equal(h.store.state.stats.done, before.stats.done);
    assert.deepEqual(h.store.state.history, before.history);
  });

  for (const status of ['axis', 'resolving', 'done', 'note']) {
    it(`is a true no-op on ${a(status)} item`, async () => {
      const h = await setupWithStatus(status);
      assertNoOp(h, () => h.store.fileAsNote('a'), `fileAsNote on ${a(status)} item`);
    });
  }

  it('is a true no-op on an unknown id', async () => {
    const h = await setup([dump({ id: 'a' })]);
    assertNoOp(h, () => h.store.fileAsNote('nobody'), 'fileAsNote on an unknown id');
  });

  it('a capture filed as a note straight away leaves the listed count as it was before the capture', async () => {
    const h = await setup([], { listed: 5 });
    const id = h.store.addTask('actually just a thought');
    assert.equal(h.listed(), 6);
    h.store.fileAsNote(id);
    assert.equal(h.listed(), 5);
  });
});

describe('unfileNote(id): note -> dump', () => {
  it('sends a note back to the dump: status "dump"', async () => {
    const h = await setup([note({ id: 'a' })]);
    h.store.unfileNote('a');
    assert.equal(h.row().status, 'dump');
  });

  it('comes back untagged', async () => {
    const h = await setup([note({ id: 'a' })]);
    h.store.unfileNote('a');
    assert.equal(h.row().quad, null);
  });

  it('puts one back on stats.listed: it is a task again', async () => {
    const h = await setup([note({ id: 'a' })], { listed: 5 });
    h.store.unfileNote('a');
    assert.equal(h.listed(), 6);
  });

  it('stamps updatedAt with the current time', async () => {
    const h = await setup([note({ id: 'a', updatedAt: EARLIER })]);
    moveClockTo(LATER);
    h.store.unfileNote('a');
    assert.equal(h.row().updatedAt, LATER);
  });

  it('keeps the text, body, linkTitle and createdAt of the note', async () => {
    const h = await setup([note({ id: 'a', text: 'https://example.com/a', body: 'why I saved it', linkTitle: 'Example A', updatedAt: EARLIER })]);
    const before = structuredClone(h.row());
    h.store.unfileNote('a');
    assert.deepEqual(without(h.row(), 'status', 'quad', 'updatedAt'), without(before, 'status', 'quad', 'updatedAt'));
  });

  it('saves once and notifies once', async () => {
    const h = await setup([note({ id: 'a' })]);
    assertCommittedOnce(h, () => h.store.unfileNote('a'));
  });

  it('changes nothing but this item and stats.listed', async () => {
    const h = await setup([note({ id: 'a' }), dump({ id: 'b' }), axis({ id: 'c' }), done({ id: 'd' })], { history: [{ id: 'd' }] });
    const before = structuredClone(h.store.state);
    h.store.unfileNote('a');
    assert.deepEqual(others(h.store.state), others(before));
    assert.equal(h.store.state.stats.done, before.stats.done);
    assert.deepEqual(h.store.state.history, before.history);
  });

  for (const status of ['dump', 'axis', 'resolving', 'done']) {
    it(`is a true no-op on ${a(status)} item`, async () => {
      const h = await setupWithStatus(status);
      assertNoOp(h, () => h.store.unfileNote('a'), `unfileNote on ${a(status)} item`);
    });
  }

  it('is a true no-op on an unknown id', async () => {
    const h = await setup([note({ id: 'a' })]);
    assertNoOp(h, () => h.store.unfileNote('nobody'), 'unfileNote on an unknown id');
  });

  it('an unfiled note is an ordinary dump again: it can be tagged and pushed to the axis', async () => {
    const h = await setup([note({ id: 'a' })]);
    h.store.unfileNote('a');
    h.store.tagTask('a', 1);
    assert.equal(h.row().quad, 1);
    h.store.dispatchToAxis('a');
    assert.equal(h.row().status, 'axis');
  });
});

describe('filing and unfiling', () => {
  it('a round trip file -> unfile leaves stats.listed where it started', async () => {
    const h = await setup([dump({ id: 'a' })], { listed: 5 });
    h.store.fileAsNote('a');
    h.store.unfileNote('a');
    assert.equal(h.listed(), 5);
  });

  it('a round trip file -> unfile leaves a dump item with its text and body', async () => {
    const h = await setup([dump({ id: 'a', text: 'ring the bank', body: 'ask about the fee' })]);
    h.store.fileAsNote('a');
    h.store.unfileNote('a');
    assert.equal(h.row().status, 'dump');
    assert.equal(h.row().quad, null);
    assert.equal(h.row().text, 'ring the bank');
    assert.equal(h.row().body, 'ask about the fee');
  });

  it('a note born in the capture box can be sent to the dump, and then counts as listed', async () => {
    const h = await setup([], { listed: 5 });
    const id = h.store.addNote('maybe later');
    assert.equal(h.listed(), 5);
    h.store.unfileNote(id);
    assert.equal(h.row(id).status, 'dump');
    assert.equal(h.listed(), 6);
  });
});

describe('setBody(id, body)', () => {
  for (const status of ['dump', 'axis', 'done', 'note']) {
    it(`sets the body of ${a(status)} item`, async () => {
      const h = await setupWithStatus(status);
      h.store.setBody('a', 'first line\nsecond line');
      assert.equal(h.row().body, 'first line\nsecond line');
    });
  }

  it('is a true no-op on a thread that is resolving', async () => {
    const h = await setupResolving({ body: 'old body' });
    assertNoOp(h, () => h.store.setBody('a', 'new body'), 'setBody on a resolving thread');
  });

  it('replaces an existing body', async () => {
    const h = await setup([note({ id: 'a', body: 'old body' })]);
    h.store.setBody('a', 'new body');
    assert.equal(h.row().body, 'new body');
  });

  it('trims trailing whitespace but keeps leading whitespace', async () => {
    const h = await setup([note({ id: 'a' })]);
    h.store.setBody('a', '  indented first line\nsecond line \t\n\n  ');
    assert.equal(h.row().body, '  indented first line\nsecond line');
  });

  it('keeps leading newlines too: only the end is trimmed', async () => {
    const h = await setup([note({ id: 'a' })]);
    h.store.setBody('a', '\n\nafter a gap\n');
    assert.equal(h.row().body, '\n\nafter a gap');
  });

  it('keeps whitespace inside the text as it is', async () => {
    const h = await setup([note({ id: 'a' })]);
    h.store.setBody('a', 'one   two\n\n\nthree');
    assert.equal(h.row().body, 'one   two\n\n\nthree');
  });

  for (const [label, value] of [['an empty string', ''], ['whitespace only', ' \n\t  \n']]) {
    it(`removes the body key altogether for ${label}`, async () => {
      const h = await setup([note({ id: 'a', body: 'old body' })]);
      h.store.setBody('a', value);
      assert.equal(has(h.row(), 'body'), false);
    });
  }

  for (const [label, value] of [['undefined', undefined], ['null', null], ['a number', 42], ['an object', { text: 'x' }], ['an array', ['x']], ['a boolean', true]]) {
    it(`treats ${label} as an empty body: the key is removed`, async () => {
      const h = await setup([note({ id: 'a', body: 'old body' })]);
      h.store.setBody('a', value);
      assert.equal(has(h.row(), 'body'), false);
    });
  }

  it('is a true no-op when the value is identical to the current body', async () => {
    const h = await setup([note({ id: 'a', body: 'same body', updatedAt: EARLIER })]);
    moveClockTo(LATER);
    assertNoOp(h, () => h.store.setBody('a', 'same body'), 'setBody with the same body');
  });

  it('is a true no-op when the value only differs from the current body by trailing whitespace', async () => {
    const h = await setup([note({ id: 'a', body: 'same body', updatedAt: EARLIER })]);
    moveClockTo(LATER);
    assertNoOp(h, () => h.store.setBody('a', 'same body \n\n'), 'setBody with the same body plus trailing whitespace');
  });

  it('is a true no-op when clearing a body that is already absent', async () => {
    const h = await setup([note({ id: 'a', updatedAt: EARLIER })]);
    moveClockTo(LATER);
    assertNoOp(h, () => h.store.setBody('a', ''), 'setBody("") on an item without a body');
    assertNoOp(h, () => h.store.setBody('a', '   '), 'setBody("   ") on an item without a body');
    assertNoOp(h, () => h.store.setBody('a', null), 'setBody(null) on an item without a body');
  });

  it('stamps updatedAt with the current time', async () => {
    const h = await setup([note({ id: 'a', body: 'old body', updatedAt: EARLIER })]);
    moveClockTo(LATER);
    h.store.setBody('a', 'new body');
    assert.equal(h.row().updatedAt, LATER);
  });

  it('stamps updatedAt on a task that never had one', async () => {
    const h = await setup([axis({ id: 'a' })]);
    moveClockTo(LATER);
    h.store.setBody('a', 'some detail');
    assert.equal(h.row().updatedAt, LATER);
  });

  it('stamps updatedAt when it removes the body, too', async () => {
    const h = await setup([note({ id: 'a', body: 'old body', updatedAt: EARLIER })]);
    moveClockTo(LATER);
    h.store.setBody('a', '');
    assert.equal(h.row().updatedAt, LATER);
  });

  it('saves once and notifies once', async () => {
    const h = await setup([note({ id: 'a', body: 'old body' })]);
    assertCommittedOnce(h, () => h.store.setBody('a', 'new body'));
    assert.equal(h.savedRow().body, 'new body');
  });

  it('saves once and notifies once when it removes the body', async () => {
    const h = await setup([note({ id: 'a', body: 'old body' })]);
    assertCommittedOnce(h, () => h.store.setBody('a', ''));
    assert.equal(has(h.savedRow(), 'body'), false);
  });

  it('changes nothing but body and updatedAt', async () => {
    const h = await setup([note({ id: 'a', text: 'https://example.com/a', linkTitle: 'Example A' }), dump({ id: 'b' }), axis({ id: 'c' }), done({ id: 'd' })], { history: [{ id: 'd' }] });
    const before = structuredClone(h.store.state);
    h.store.setBody('a', 'new body');
    assert.deepEqual(without(h.row(), 'body', 'updatedAt'), without(before.threads[0], 'body', 'updatedAt'));
    assert.deepEqual(others(h.store.state), others(before));
    assert.deepEqual(h.store.state.stats, before.stats);
    assert.deepEqual(h.store.state.history, before.history);
  });

  it('is a true no-op on an unknown id', async () => {
    const h = await setup([note({ id: 'a' })]);
    assertNoOp(h, () => h.store.setBody('nobody', 'new body'), 'setBody on an unknown id');
  });
});

describe('setText(id, text)', () => {
  for (const status of ['dump', 'axis', 'note']) {
    it(`renames ${a(status)} item`, async () => {
      const h = await setupWithStatus(status);
      h.store.setText('a', 'a better title');
      assert.equal(h.row().text, 'a better title');
    });
  }

  for (const status of ['resolving', 'done']) {
    it(`is a true no-op on ${a(status)} item`, async () => {
      const h = await setupWithStatus(status);
      assertNoOp(h, () => h.store.setText('a', 'a better title'), `setText on ${a(status)} item`);
    });
  }

  it('trims the new text', async () => {
    const h = await setup([note({ id: 'a' })]);
    h.store.setText('a', '   fresh words \n');
    assert.equal(h.row().text, 'fresh words');
  });

  for (const blank of ['', '   ', '\n\t ']) {
    it(`ignores blank text (${JSON.stringify(blank)}): a true no-op`, async () => {
      const h = await setup([note({ id: 'a', text: 'keep me' })]);
      assertNoOp(h, () => h.store.setText('a', blank), `setText(${JSON.stringify(blank)})`);
    });
  }

  it('is a true no-op when the text is identical', async () => {
    const h = await setup([note({ id: 'a', text: 'same words', updatedAt: EARLIER })]);
    moveClockTo(LATER);
    assertNoOp(h, () => h.store.setText('a', 'same words'), 'setText with the same text');
  });

  it('is a true no-op when the text only differs by surrounding whitespace', async () => {
    const h = await setup([note({ id: 'a', text: 'same words', updatedAt: EARLIER })]);
    moveClockTo(LATER);
    assertNoOp(h, () => h.store.setText('a', '  same words \n'), 'setText with the same text plus whitespace');
  });

  it('clears linkTitle when the text changes: the title described the old text', async () => {
    const h = await setup([note({ id: 'a', text: 'https://example.com/a', linkTitle: 'Example A' })]);
    h.store.setText('a', 'a different thought');
    assert.equal(has(h.row(), 'linkTitle'), false);
  });

  it('clears linkTitle even when the new text is another URL', async () => {
    const h = await setup([note({ id: 'a', text: 'https://example.com/a', linkTitle: 'Example A' })]);
    h.store.setText('a', 'https://example.com/b');
    assert.equal(h.row().text, 'https://example.com/b');
    assert.equal(has(h.row(), 'linkTitle'), false);
  });

  it('keeps the linkTitle when the text is identical (nothing changed, so nothing is cleared)', async () => {
    const h = await setup([note({ id: 'a', text: 'https://example.com/a', linkTitle: 'Example A', updatedAt: EARLIER })]);
    assertNoOp(h, () => h.store.setText('a', 'https://example.com/a'), 'setText with the same URL');
  });

  it('stamps updatedAt with the current time', async () => {
    const h = await setup([note({ id: 'a', updatedAt: EARLIER })]);
    moveClockTo(LATER);
    h.store.setText('a', 'a better title');
    assert.equal(h.row().updatedAt, LATER);
  });

  it('stamps updatedAt on a task that never had one', async () => {
    const h = await setup([dump({ id: 'a' })]);
    moveClockTo(LATER);
    h.store.setText('a', 'a better title');
    assert.equal(h.row().updatedAt, LATER);
  });

  it('saves once and notifies once', async () => {
    const h = await setup([note({ id: 'a' })]);
    assertCommittedOnce(h, () => h.store.setText('a', 'a better title'));
    assert.equal(h.savedRow().text, 'a better title');
  });

  it('changes nothing but text, linkTitle and updatedAt', async () => {
    const h = await setup([note({ id: 'a', text: 'https://example.com/a', linkTitle: 'Example A', body: 'my own notes' }), dump({ id: 'b' }), axis({ id: 'c' }), done({ id: 'd' })], { history: [{ id: 'd' }] });
    const before = structuredClone(h.store.state);
    h.store.setText('a', 'a different thought');
    assert.deepEqual(without(h.row(), 'text', 'linkTitle', 'updatedAt'), without(before.threads[0], 'text', 'linkTitle', 'updatedAt'));
    assert.deepEqual(others(h.store.state), others(before));
    assert.deepEqual(h.store.state.stats, before.stats);
    assert.deepEqual(h.store.state.history, before.history);
  });

  it('is a true no-op on an unknown id', async () => {
    const h = await setup([note({ id: 'a' })]);
    assertNoOp(h, () => h.store.setText('nobody', 'a better title'), 'setText on an unknown id');
  });
});

describe('setLinkTitle(id, url, title)', () => {
  const URL_A = 'https://example.com/a';

  for (const status of STATUSES) {
    it(`sets the title on ${a(status)} item whose text is that URL`, async () => {
      const h = await setupWithStatus(status, { text: URL_A });
      h.store.setLinkTitle('a', URL_A, 'Example A');
      assert.equal(h.row().linkTitle, 'Example A');
    });
  }

  it('only text.trim() has to equal the url: stored text with surrounding whitespace still matches', async () => {
    const h = await setup([note({ id: 'a', text: `  ${URL_A} \n` })]);
    h.store.setLinkTitle('a', URL_A, 'Example A');
    assert.equal(h.row().linkTitle, 'Example A');
  });

  it('is a true no-op when the text is no longer that URL', async () => {
    const h = await setup([note({ id: 'a', text: 'something I typed instead', updatedAt: EARLIER })]);
    assertNoOp(h, () => h.store.setLinkTitle('a', URL_A, 'Example A'), 'setLinkTitle for a URL the text no longer is');
  });

  it('is a true no-op when the text is the URL plus more words', async () => {
    const h = await setup([note({ id: 'a', text: `${URL_A} is worth a read`, updatedAt: EARLIER })]);
    assertNoOp(h, () => h.store.setLinkTitle('a', URL_A, 'Example A'), 'setLinkTitle when the text has more than the URL');
  });

  it('is a true no-op when the url differs only in case: it must match exactly', async () => {
    const h = await setup([note({ id: 'a', text: URL_A, updatedAt: EARLIER })]);
    assertNoOp(h, () => h.store.setLinkTitle('a', 'HTTPS://EXAMPLE.COM/A', 'Example A'), 'setLinkTitle with a differently cased url');
  });

  it('is a true no-op when the url differs only by a trailing slash', async () => {
    const h = await setup([note({ id: 'a', text: URL_A, updatedAt: EARLIER })]);
    assertNoOp(h, () => h.store.setLinkTitle('a', `${URL_A}/`, 'Example A'), 'setLinkTitle with a trailing slash');
  });

  it('is a true no-op when the url argument itself has surrounding whitespace: exact match only', async () => {
    const h = await setup([note({ id: 'a', text: URL_A, updatedAt: EARLIER })]);
    assertNoOp(h, () => h.store.setLinkTitle('a', ` ${URL_A} `, 'Example A'), 'setLinkTitle with a padded url');
  });

  for (const blank of ['', '   ', '\n\t ']) {
    it(`ignores a blank title (${JSON.stringify(blank)}): a true no-op`, async () => {
      const h = await setup([note({ id: 'a', text: URL_A, updatedAt: EARLIER })]);
      assertNoOp(h, () => h.store.setLinkTitle('a', URL_A, blank), `setLinkTitle(${JSON.stringify(blank)})`);
    });
  }

  for (const [label, value] of [['undefined', undefined], ['null', null], ['a number', 42], ['an object', { title: 'x' }], ['an array', ['x']], ['a boolean', true]]) {
    it(`ignores a title that is not a string (${label}): a true no-op`, async () => {
      const h = await setup([note({ id: 'a', text: URL_A, updatedAt: EARLIER })]);
      assertNoOp(h, () => h.store.setLinkTitle('a', URL_A, value), `setLinkTitle(${label})`);
    });
  }

  it('is a true no-op on an unknown id', async () => {
    const h = await setup([note({ id: 'a', text: URL_A })]);
    assertNoOp(h, () => h.store.setLinkTitle('nobody', URL_A, 'Example A'), 'setLinkTitle on an unknown id');
  });

  it('stamps updatedAt with the current time', async () => {
    const h = await setup([note({ id: 'a', text: URL_A, updatedAt: EARLIER })]);
    moveClockTo(LATER);
    h.store.setLinkTitle('a', URL_A, 'Example A');
    assert.equal(h.row().updatedAt, LATER);
  });

  it('stamps updatedAt on a task that never had one', async () => {
    const h = await setup([dump({ id: 'a', text: URL_A })]);
    moveClockTo(LATER);
    h.store.setLinkTitle('a', URL_A, 'Example A');
    assert.equal(h.row().updatedAt, LATER);
  });

  it('saves once and notifies once', async () => {
    const h = await setup([note({ id: 'a', text: URL_A })]);
    assertCommittedOnce(h, () => h.store.setLinkTitle('a', URL_A, 'Example A'));
    assert.equal(h.savedRow().linkTitle, 'Example A');
  });

  it('changes nothing but linkTitle and updatedAt', async () => {
    const h = await setup([note({ id: 'a', text: URL_A, body: 'read on the train' }), dump({ id: 'b' }), axis({ id: 'c' }), done({ id: 'd' })], { history: [{ id: 'd' }] });
    const before = structuredClone(h.store.state);
    h.store.setLinkTitle('a', URL_A, 'Example A');
    assert.deepEqual(without(h.row(), 'linkTitle', 'updatedAt'), without(before.threads[0], 'linkTitle', 'updatedAt'));
    assert.deepEqual(others(h.store.state), others(before));
    assert.deepEqual(h.store.state.stats, before.stats);
    assert.deepEqual(h.store.state.history, before.history);
  });

  it('drops a title that arrives after the text was edited: the race this guard exists for', async () => {
    const h = await setup();
    const id = h.store.addTask(URL_A);                 // capturing a bare URL starts a title fetch ...
    h.store.setText(id, 'watch this on Sunday');        // ... the owner rewrites the item before it lands
    h.reset();
    assertNoOp(h, () => h.store.setLinkTitle(id, URL_A, 'Example A'), 'a late setLinkTitle');
    assert.equal(has(h.row(id), 'linkTitle'), false);
  });
});

// The other half of the updatedAt policy: the task transitions never stamp it, so a task row on disk
// looks exactly as it did before notes existed. Each case also proves the transition really happened
// (`acted`), so "no updatedAt" cannot pass just because the fixture did nothing.
describe('the task transitions never stamp updatedAt, and never disturb the new fields', () => {
  const TRANSITIONS = [
    { name: 'tagTask', start: (over) => dump({ id: 'a', ...over }), act: (s) => s.tagTask('a', 2), acted: (r) => r.quad === 2 },
    { name: 'dispatchToAxis', start: (over) => tagged({ id: 'a', ...over }), act: (s) => s.dispatchToAxis('a'), acted: (r) => r.status === 'axis' },
    { name: 'recallToDump', start: (over) => axis({ id: 'a', ...over }), act: (s) => s.recallToDump('a'), acted: (r) => r.status === 'dump' },
    { name: 'resolveThread (first step: resolving)', start: (over) => axis({ id: 'a', ...over }), act: (s) => s.resolveThread('a'), acted: (r) => r.status === 'resolving' },
    { name: 'resolveThread (second step: done)', start: (over) => axis({ id: 'a', ...over }), act: (s) => { s.resolveThread('a'); mock.timers.tick(RESOLVE_WINDOW); }, acted: (r) => r.status === 'done' },
    { name: 'reopenTask', start: (over) => done({ id: 'a', ...over }), act: (s) => s.reopenTask('a'), acted: (r) => r.status !== 'done' },
    { name: 'toggleFocus', start: (over) => axis({ id: 'a', ...over }), act: (s) => s.toggleFocus('a'), acted: (r) => Boolean(r.focused) },
  ];

  for (const t of TRANSITIONS) {
    it(`${t.name} does not give a task row an updatedAt`, async () => {
      const h = await setup([t.start()]);
      moveClockTo(LATER);
      t.act(h.store);
      assert.ok(t.acted(h.row()), `fixture: ${t.name} really happened`);
      assert.equal(has(h.row(), 'updatedAt'), false);
      for (const payload of h.saves) {
        assert.equal(has(payload.threads.find((r) => r.id === 'a'), 'updatedAt'), false, 'nor does the saved row have one');
      }
    });

    it(`${t.name} leaves an updatedAt the row already had exactly as it was`, async () => {
      const h = await setup([t.start({ updatedAt: EARLIER })]);
      moveClockTo(LATER);
      t.act(h.store);
      assert.ok(t.acted(h.row()), `fixture: ${t.name} really happened`);
      assert.equal(h.row().updatedAt, EARLIER);
    });

    it(`${t.name} keeps the body and the linkTitle of the row`, async () => {
      const h = await setup([t.start({ text: 'https://example.com/a', body: 'some detail', linkTitle: 'Example A' })]);
      t.act(h.store);
      assert.ok(t.acted(h.row()), `fixture: ${t.name} really happened`);
      assert.equal(h.row().body, 'some detail');
      assert.equal(h.row().linkTitle, 'Example A');
    });
  }
});

// `status` is the single discriminator: a note can never be half a task. Every task transition
// is a true no-op on a note (and must not disturb the tasks around it).
describe('notes never take part in the task machinery', () => {
  const aNote = () => note({ id: 'a', text: 'a thought', body: 'with some detail', linkTitle: 'A title', updatedAt: EARLIER });
  const withTasksAround = () => [aNote(), dump({ id: 'b' }), tagged({ id: 'c', quad: 1 }), axis({ id: 'd', focused: true }), done({ id: 'e' })];

  for (const q of [1, 2, 3, 4]) {
    it(`tagTask(id, ${q}) is a true no-op on a note: it stays untagged`, async () => {
      const h = await setup(withTasksAround());
      assertNoOp(h, () => h.store.tagTask('a', q), `tagTask(note, ${q})`);
      assert.equal(h.row().quad, null);
    });
  }

  it('dispatchToAxis is a true no-op on a note: it never reaches the axis', async () => {
    const h = await setup(withTasksAround());
    assertNoOp(h, () => h.store.dispatchToAxis('a'), 'dispatchToAxis(note)');
    assert.equal(h.row().status, 'note');
  });

  it('recallToDump is a true no-op on a note: only unfileNote sends a note to the dump', async () => {
    const h = await setup(withTasksAround());
    assertNoOp(h, () => h.store.recallToDump('a'), 'recallToDump(note)');
    assert.equal(h.row().status, 'note');
  });

  it('resolveThread is a true no-op on a note, and nothing finishes it later either', async () => {
    const h = await setup(withTasksAround(), { doneCount: 2 });
    assertNoOp(h, () => h.store.resolveThread('a'), 'resolveThread(note)');
    mock.timers.tick(RESOLVE_WINDOW * 5);
    assert.equal(h.row().status, 'note');
    assert.equal(h.store.state.stats.done, 2);
    assert.deepEqual(h.store.state.history, []);
    assert.equal(h.saves.length, 0, 'no save appeared once the resolve window passed');
    assert.equal(h.rendered.length, 0, 'no re-render appeared once the resolve window passed');
  });

  it('reopenTask is a true no-op on a note', async () => {
    const h = await setup(withTasksAround());
    assertNoOp(h, () => h.store.reopenTask('a'), 'reopenTask(note)');
    assert.equal(h.row().status, 'note');
  });

  it('toggleFocus is a true no-op on a note: it gets no focused flag and the focused thread keeps its focus', async () => {
    const h = await setup(withTasksAround());
    assertNoOp(h, () => h.store.toggleFocus('a'), 'toggleFocus(note)');
    assert.equal(has(h.row(), 'focused'), false);
    assert.equal(h.row('d').focused, true);
  });
});
