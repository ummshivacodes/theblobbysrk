import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { activeThreads, inboxItems, notes, searchNotes, noteCount } from '../../src/core/selectors.js';

// Invisible and look-alike characters, built from code points so they stay visible in review.
const NBSP = String.fromCharCode(0xa0);

// A write to a frozen object throws (ES modules are strict), and sorting a
// frozen array throws too, so a frozen state proves nothing gets mutated.
function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Reflect.ownKeys(value)) deepFreeze(value[key]);
  }
  return value;
}

const item = (id, status, createdAt, extra = {}) => ({ id, text: `text ${id}`, status, quad: null, createdAt, ...extra });
const ids = (list) => list.map((t) => t.id);
const stateOf = (...threads) => ({ version: 2, threads, stats: { listed: 0, done: 0 }, history: [] });

// Deliberately not in createdAt order, so a selector that forgets to sort shows.
const mixed = () =>
  stateOf(
    item('d1', 'dump', 50),
    item('a3', 'axis', 30, { quad: 1 }),
    item('n1', 'note', 10, { text: 'Groceries' }),
    item('r1', 'resolving', 20, { quad: 2 }),
    item('x1', 'done', 5, { quad: 3, doneAt: 99 }),
    item('n2', 'note', 40, { text: 'Idea', updatedAt: 90 }),
    item('a1', 'axis', 10, { quad: 4 }),
    item('n3', 'note', 60, { text: 'Newest note' }),
  );

describe('activeThreads', () => {
  it('is the axis and resolving items, oldest first', () => {
    assert.deepEqual(ids(activeThreads(mixed())), ['a1', 'r1', 'a3']);
  });

  it('leaves out dump, done and note items', () => {
    const state = stateOf(item('d', 'dump', 1), item('x', 'done', 2), item('n', 'note', 3));
    assert.deepEqual(activeThreads(state), []);
  });

  it('keeps the original order of items created at the same moment', () => {
    const state = stateOf(item('c', 'axis', 5), item('a', 'axis', 5), item('b', 'resolving', 5));
    assert.deepEqual(ids(activeThreads(state)), ['c', 'a', 'b']);
  });
});

describe('inboxItems', () => {
  it('is everything except notes, oldest first', () => {
    assert.deepEqual(ids(inboxItems(mixed())), ['x1', 'a1', 'r1', 'a3', 'd1']);
  });

  it('includes every non-note status', () => {
    const state = stateOf(
      item('1', 'dump', 1),
      item('2', 'axis', 2),
      item('3', 'resolving', 3),
      item('4', 'done', 4),
      item('5', 'note', 5),
    );
    assert.deepEqual(ids(inboxItems(state)), ['1', '2', '3', '4']);
  });

  it('keeps the original order of items created at the same moment', () => {
    const state = stateOf(item('c', 'dump', 5), item('a', 'done', 5), item('b', 'axis', 5));
    assert.deepEqual(ids(inboxItems(state)), ['c', 'a', 'b']);
  });

  it('sorts an item with a missing or garbage createdAt as oldest, without upsetting the rest', () => {
    const state = stateOf(item('b', 'dump', 5), { id: 'a', status: 'dump' }, item('c', 'dump', NaN), item('d', 'dump', 1));
    assert.deepEqual(ids(inboxItems(state)), ['a', 'c', 'd', 'b']);
  });
});

describe('notes', () => {
  it('is notes only, most recently edited first (updatedAt, else createdAt)', () => {
    // n2: edited at 90, n3: created at 60, n1: created at 10.
    assert.deepEqual(ids(notes(mixed())), ['n2', 'n3', 'n1']);
  });

  it('ties on edit time go to the newer note, then to the lower id', () => {
    const state = stateOf(
      item('older', 'note', 10, { updatedAt: 100 }),
      item('newer', 'note', 20, { updatedAt: 100 }),
      item('fallback', 'note', 100), // no updatedAt: edited = created = 100
    );
    // All edited at 100. createdAt: fallback 100, newer 20, older 10.
    assert.deepEqual(ids(notes(state)), ['fallback', 'newer', 'older']);

    const sameEverything = stateOf(
      item('b', 'note', 7, { updatedAt: 9 }),
      item('c', 'note', 7, { updatedAt: 9 }),
      item('a', 'note', 7, { updatedAt: 9 }),
    );
    assert.deepEqual(ids(notes(sameEverything)), ['a', 'b', 'c']);
  });

  it('breaks ties by plain id order, not by locale', () => {
    const state = stateOf(item('b', 'note', 1), item('B', 'note', 1), item('a', 'note', 1));
    assert.deepEqual(ids(notes(state)), ['B', 'a', 'b']);
  });

  it('keeps the original order of notes that tie on everything', () => {
    const state = stateOf(item('same', 'note', 1, { text: 'first' }), item('same', 'note', 1, { text: 'second' }));
    assert.deepEqual(notes(state).map((n) => n.text), ['first', 'second']);
  });

  it('a garbage updatedAt falls back to createdAt', () => {
    const state = stateOf(
      item('q', 'note', 50, { updatedAt: 80 }),
      item('p', 'note', 100, { updatedAt: 'yesterday' }),
      item('r', 'note', 60, { updatedAt: NaN }),
    );
    assert.deepEqual(ids(notes(state)), ['p', 'q', 'r']);
  });

  it('an updatedAt of 0 counts as a real (very old) edit time', () => {
    const state = stateOf(item('zero', 'note', 500, { updatedAt: 0 }), item('one', 'note', 1));
    assert.deepEqual(ids(notes(state)), ['one', 'zero']);
  });

  it('is empty when there are no notes', () => {
    assert.deepEqual(notes(stateOf(item('a', 'axis', 1), item('d', 'dump', 2))), []);
  });

  it('once notes have a manual order (drag-and-drop), it wins over recency, however out of time order it is', () => {
    const state = stateOf(
      item('n1', 'note', 10, { updatedAt: 500, order: 2 }), // most recently edited, but ordered last
      item('n2', 'note', 20, { updatedAt: 100, order: 0 }), // edited longest ago, but ordered first
      item('n3', 'note', 30, { updatedAt: 300, order: 1 }),
    );
    assert.deepEqual(ids(notes(state)), ['n2', 'n3', 'n1']);
  });

  it('a note with an order always sorts before one without, whatever their times say', () => {
    const state = stateOf(
      item('unordered', 'note', 10, { updatedAt: 999 }), // no order: would otherwise sort first
      item('ordered', 'note', 20, { updatedAt: 1, order: 0 }),
    );
    assert.deepEqual(ids(notes(state)), ['ordered', 'unordered']);
  });

  it('among notes that all lack an order, falls back to newest-edited-first, exactly as before this feature', () => {
    const state = stateOf(item('old', 'note', 10, { updatedAt: 10 }), item('new', 'note', 20, { updatedAt: 20 }));
    assert.deepEqual(ids(notes(state)), ['new', 'old']);
  });

  it('a non-finite order (NaN, a string, Infinity) is treated as no order at all, not as a sort key', () => {
    const state = stateOf(
      item('a', 'note', 10, { order: NaN }),
      item('b', 'note', 20, { order: '1' }),
      item('c', 'note', 30, { order: 0 }),
    );
    // c has the only real order, so it goes first; a and b (both order-less) fall back to newest-edited-first.
    assert.deepEqual(ids(notes(state)), ['c', 'b', 'a']);
  });
});

describe('searchNotes', () => {
  const searchable = () =>
    stateOf(
      item('n1', 'note', 10, { text: 'Groceries', body: 'Milk and eggs\nfor the weekend' }),
      item('n2', 'note', 20, { text: 'Read later', body: '', linkTitle: 'How to Cook Rice: A Guide' }),
      item('n3', 'note', 30, { text: 'Rice pudding' }),
      item('n4', 'note', 40, { text: 'Café au lait' }),
      item('n5', 'note', 50, { text: 'c++ (draft) [v2] a.b' }),
      item('n6', 'note', 5, { text: 'foo', body: 'bar' }),
      item('t1', 'dump', 60, { text: 'rice task' }),
      item('t2', 'axis', 70, { text: 'more rice', body: 'rice' }),
    );

  it('an empty or blank query is the whole notes list', () => {
    const state = searchable();
    for (const query of ['', ' ', '\n\t  ', undefined, null, 0, 5, true, {}, [], ['rice'], Symbol('q')]) {
      assert.deepEqual(searchNotes(state, query), notes(state), String(typeof query));
    }
  });

  it('matches the title, the body and the link title, ignoring case', () => {
    const state = searchable();
    assert.deepEqual(ids(searchNotes(state, 'groceries')), ['n1']);
    assert.deepEqual(ids(searchNotes(state, 'WEEKEND')), ['n1']);
    assert.deepEqual(ids(searchNotes(state, 'guide')), ['n2']);
    assert.deepEqual(ids(searchNotes(state, 'rIcE')), ['n3', 'n2']);
  });

  it('never returns anything that is not a note', () => {
    for (const note of searchNotes(searchable(), 'rice')) assert.equal(note.status, 'note');
    assert.deepEqual(searchNotes(searchable(), 'more'), []);
  });

  it('every word must match, in any order and in any field', () => {
    const state = searchable();
    assert.deepEqual(ids(searchNotes(state, 'milk weekend')), ['n1']);
    assert.deepEqual(ids(searchNotes(state, 'weekend milk')), ['n1']);
    assert.deepEqual(ids(searchNotes(state, 'groceries eggs')), ['n1']); // title + body
    assert.deepEqual(ids(searchNotes(state, 'later guide')), ['n2']); // title + link title
    assert.deepEqual(searchNotes(state, 'milk rice'), []);
  });

  it('matches substrings, not just whole words', () => {
    assert.deepEqual(ids(searchNotes(searchable(), 'oce')), ['n1']);
  });

  it('splits the query on any whitespace and ignores the extra', () => {
    assert.deepEqual(ids(searchNotes(searchable(), '  milk \n\t weekend  ')), ['n1']);
    assert.deepEqual(ids(searchNotes(searchable(), 'milk' + NBSP + 'weekend')), ['n1']);
  });

  it('keeps the notes() order', () => {
    const state = searchable();
    const all = ids(notes(state));
    for (const query of ['rice', 'e', 'a']) {
      const hits = ids(searchNotes(state, query));
      assert.deepEqual(hits, all.filter((id) => hits.includes(id)), query);
    }
  });

  it('treats the query as literal text, never as a pattern', () => {
    const state = searchable();
    assert.deepEqual(ids(searchNotes(state, 'c++')), ['n5']);
    assert.deepEqual(ids(searchNotes(state, '(draft)')), ['n5']);
    assert.deepEqual(ids(searchNotes(state, '[v2]')), ['n5']);
    assert.deepEqual(ids(searchNotes(state, 'a.b')), ['n5']);
    assert.deepEqual(searchNotes(state, '.*'), []);
    assert.deepEqual(ids(searchNotes(state, '[')), ['n5']); // a bare "[" would be an invalid pattern
  });

  it('is unicode-aware and case-insensitive there too', () => {
    assert.deepEqual(ids(searchNotes(searchable(), 'CAFÉ')), ['n4']);
  });

  it('a note without a body or link title does not match "undefined" or "null"', () => {
    const state = searchable();
    assert.deepEqual(searchNotes(state, 'undefined'), []);
    assert.deepEqual(searchNotes(state, 'null'), []);
  });

  it('does not match across the gap between fields', () => {
    assert.deepEqual(searchNotes(searchable(), 'foobar'), []);
    assert.deepEqual(ids(searchNotes(searchable(), 'foo bar')), ['n6']);
  });

  it('finds nothing when nothing matches', () => {
    assert.deepEqual(searchNotes(searchable(), 'zzz'), []);
  });
});

describe('noteCount', () => {
  it('counts notes and nothing else', () => {
    assert.equal(noteCount(mixed()), 3);
    assert.equal(noteCount(stateOf(item('a', 'axis', 1), item('d', 'dump', 2))), 0);
    assert.equal(noteCount(stateOf()), 0);
  });
});

describe('all selectors', () => {
  const everySelector = (state) => [
    activeThreads(state),
    inboxItems(state),
    notes(state),
    searchNotes(state, ''),
    searchNotes(state, 'anything'),
    noteCount(state),
  ];

  it('treat a state with no usable threads list as empty', () => {
    const broken = [
      undefined,
      null,
      {},
      [],
      'state',
      42,
      { threads: undefined },
      { threads: null },
      { threads: 'abc' },
      { threads: 5 },
      { threads: {} },
      { threads: { length: 1, 0: { status: 'note', createdAt: 1 } } },
    ];
    for (const state of broken) {
      assert.deepEqual(everySelector(state), [[], [], [], [], [], 0], String(typeof state));
    }
  });

  it('skip entries that are not items, instead of crashing on them', () => {
    const state = {
      threads: [null, 7, 'x', [], undefined, item('ok', 'note', 1), item('open', 'dump', 2), true],
    };
    assert.deepEqual(ids(notes(state)), ['ok']);
    assert.deepEqual(ids(inboxItems(state)), ['open']);
    assert.deepEqual(activeThreads(state), []);
    assert.equal(noteCount(state), 1);
    assert.deepEqual(ids(searchNotes(state, 'ok')), ['ok']);
  });

  it('never mutate the state', () => {
    const state = deepFreeze(mixed());
    const order = ids(state.threads);
    // Frozen: any write, including sorting state.threads in place, would throw.
    assert.deepEqual(ids(activeThreads(state)), ['a1', 'r1', 'a3']);
    assert.deepEqual(ids(inboxItems(state)), ['x1', 'a1', 'r1', 'a3', 'd1']);
    assert.deepEqual(ids(notes(state)), ['n2', 'n3', 'n1']);
    assert.deepEqual(ids(searchNotes(state, 'idea')), ['n2']);
    assert.equal(noteCount(state), 3);
    assert.deepEqual(ids(state.threads), order);
  });

  it('leave state.threads in its stored order', () => {
    const state = mixed();
    const order = ids(state.threads);
    activeThreads(state);
    inboxItems(state);
    notes(state);
    searchNotes(state, 'a');
    assert.deepEqual(ids(state.threads), order);
  });

  it('return a fresh array every call, so callers may reorder or empty it', () => {
    const state = mixed();
    for (const select of [activeThreads, inboxItems, notes, (s) => searchNotes(s, ''), (s) => searchNotes(s, 'note')]) {
      const first = select(state);
      const before = ids(first);
      first.reverse();
      first.length = 0;
      assert.deepEqual(ids(select(state)), before);
      assert.notEqual(select(state), select(state));
    }
  });

  it('do not depend on anything but the state (same input, same output)', () => {
    const state = mixed();
    assert.deepEqual(everySelector(state), everySelector(state));
    assert.deepEqual(everySelector(state), everySelector(structuredClone(state)));
  });
});
