import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { migrate } from '../../src/core/migrate.js';
import { toHistory } from '../../src/core/history.js';

// A write to a frozen object throws (ES modules are strict), so a frozen input
// proves migrate never writes to what it is given.
function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Reflect.ownKeys(value)) deepFreeze(value[key]);
  }
  return value;
}

const EMPTY = () => ({ version: 2, threads: [], stats: { listed: 0, done: 0 }, history: [] });
const item = (id, status, extra = {}) => ({
  id,
  text: `text ${id}`,
  status,
  quad: status === 'note' ? null : 1,
  createdAt: 1000,
  ...extra,
});

// What a file written by the app before notes existed looks like.
const v1File = () => ({
  threads: [
    { id: 'a', text: 'write report', quad: 1, status: 'axis', createdAt: 100, focused: true },
    { id: 'b', text: 'call mum', quad: 2, status: 'done', createdAt: 200, doneAt: 900 },
    { id: 'c', text: 'untagged', quad: null, status: 'dump', createdAt: 300 },
    { id: 'd', text: 'pay rent', quad: 3, status: 'done', createdAt: 400, doneAt: 950, extra: { keep: 'me' } },
    { id: 'e', text: 'in flight', quad: 1, status: 'resolving', createdAt: 500 },
  ],
});

describe('migrate: input that is not a usable state', () => {
  const revoked = (() => {
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    return proxy;
  })();

  const unusable = [
    ['undefined', undefined],
    ['null', null],
    ['a number', 42],
    ['NaN', NaN],
    ['a string', 'threads'],
    ['an empty string', ''],
    ['true', true],
    ['a symbol', Symbol('s')],
    ['a bigint', 10n],
    ['a function', () => ({ threads: [] })],
    ['an array', []],
    ['an array of items', [{ id: 'a' }]],
    ['a Date', new Date(0)],
    ['a Map', new Map([['threads', []]])],
    ['an empty object', {}],
    ['threads: null', { threads: null }],
    ['threads: undefined', { threads: undefined }],
    ['threads: a string', { threads: 'abc' }],
    ['threads: a number', { threads: 3 }],
    ['threads: an object', { threads: { 0: { id: 'a' }, length: 1 } }],
    ['a newer file without a threads array', { version: 3, items: [] }],
    // None of these can be cloned, so none can have come out of a JSON file.
    ['a revoked proxy', revoked],
    ['a live proxy', new Proxy({ threads: [] }, {})],
    ['a getter that throws', { get threads() { throw new Error('boom'); } }],
    ['a function inside an item', { threads: [{ id: 'a', run() {} }] }],
    ['a symbol inside an item', { threads: [{ id: Symbol('a') }] }],
    ['a function inside stats', { threads: [], stats: { listed: () => 1, done: 0 } }],
  ];

  for (const [name, input] of unusable) {
    it(`${name}: an empty v2 state, and no throw`, () => {
      assert.deepEqual(migrate(input), EMPTY());
    });
  }

  it('hands out a new empty state every time', () => {
    const first = migrate(null);
    first.threads.push({ id: 'x' });
    first.stats.listed = 9;
    first.history.push({ id: 'x' });
    assert.deepEqual(migrate(null), EMPTY());
    assert.notEqual(migrate(null), migrate(null));
  });
});

describe('migrate: odd but readable input is read, not thrown away', () => {
  it('an object with no prototype', () => {
    const saved = Object.assign(Object.create(null), { threads: [Object.assign(Object.create(null), { id: 'a' })] });
    assert.deepEqual(migrate(saved).threads, [{ id: 'a' }]);
  });

  it('an object built in another realm (a vm context), whose Object.prototype is not ours', () => {
    const saved = vm.runInNewContext('({ version: 1, threads: [{ id: "a", status: "dump", meta: { k: [1, 2] } }] })');
    assert.notEqual(Object.getPrototypeOf(saved), Object.prototype); // the premise of this test
    assert.deepEqual(migrate(saved), {
      version: 2,
      threads: [{ id: 'a', status: 'dump', meta: { k: [1, 2] } }],
      stats: { listed: 1, done: 0 },
      history: [],
    });
  });

  it('a class instance: its own data is data, nothing is lost', () => {
    class Saved {
      constructor() {
        this.threads = [{ id: 'a', status: 'dump' }];
      }
    }
    assert.deepEqual(migrate(new Saved()).threads, [{ id: 'a', status: 'dump' }]);
  });

  it('a cyclic structure does not throw', () => {
    const saved = { threads: [{ id: 'a' }] };
    saved.self = saved;
    assert.doesNotThrow(() => migrate(saved));
    assert.deepEqual(migrate(saved).threads, [{ id: 'a' }]);
  });

  it('a sparse threads array loses the holes and nothing else', () => {
    // eslint-disable-next-line no-sparse-arrays
    assert.deepEqual(migrate({ threads: [{ id: 'a' }, , { id: 'b' }] }).threads, [{ id: 'a' }, { id: 'b' }]);
  });
});

describe('migrate: a v1 file (no version, stats or history)', () => {
  it('is stamped v2 with stats and history seeded from what is on disk', () => {
    const out = migrate(v1File());
    assert.equal(out.version, 2);
    assert.deepEqual(out.threads, v1File().threads);
    assert.deepEqual(out.stats, { listed: 5, done: 2 });
    assert.deepEqual(out.history, [
      { id: 'b', text: 'call mum', quad: 2, createdAt: 200, doneAt: 900 },
      { id: 'd', text: 'pay rent', quad: 3, createdAt: 400, doneAt: 950 },
    ]);
  });

  it('seeds history through toHistory, in file order', () => {
    const saved = v1File();
    const done = saved.threads.filter((t) => t.status === 'done');
    assert.deepEqual(migrate(saved).history, done.map(toHistory));
  });

  it('a file with only "version": 1 and no threads at all is an empty state', () => {
    assert.deepEqual(migrate({ version: 1 }), EMPTY());
  });

  it('a v1 file with no threads is stamped v2 and stays empty', () => {
    assert.deepEqual(migrate({ version: 1, threads: [] }), EMPTY());
    assert.deepEqual(migrate({ threads: [] }), EMPTY());
  });
});

describe('migrate: threads', () => {
  it('keeps every plain-object entry, in order, with all its fields (unknown ones too) — except a note gains a manual order', () => {
    const threads = [
      { id: 'a', text: 'a', status: 'dump', quad: null, createdAt: 1, body: 'b', updatedAt: 5, linkTitle: 't', focused: true },
      { id: 'b', status: 'note', quad: 3, createdAt: 2, futureField: { nested: [1, { deep: true }] }, nothing: null, missing: undefined },
      {}, // no id, no status: left exactly as it is
      { id: 7, status: 'weird' },
      { id: 'a', text: 'the same id again' },
    ];
    const out = migrate({ version: 2, threads, stats: { listed: 4, done: 0 }, history: [] });
    // The one note ('b') is the whole notes group, so it becomes order 0; nothing else changes.
    assert.deepEqual(out.threads, threads.map((t) => (t.status === 'note' ? { ...t, order: 0 } : t)));
  });

  it('never invents an id, an item or a field', () => {
    const out = migrate({ threads: [{}, { text: 'no id' }] });
    assert.deepEqual(out.threads, [{}, { text: 'no id' }]);
    assert.ok(!('id' in out.threads[0]));
    assert.ok(!('id' in out.threads[1]));
  });

  it('never changes a status, including ones it does not know', () => {
    const statuses = ['dump', 'axis', 'resolving', 'done', 'note', 'weird', '', 'NOTE', null, 7];
    const threads = statuses.map((status, i) => ({ id: `i${i}`, status }));
    assert.deepEqual(migrate({ threads }).threads.map((t) => t.status), statuses);
  });

  it('drops only the entries that are not plain objects', () => {
    const keepFirst = { id: 'k1', status: 'dump' };
    const keepLast = { id: 'k2', status: 'note' };
    const junk = [
      null, undefined, 0, 1, NaN, '', 'text', true, false, 10n,
      [], [1, 2], [{ id: 'nested' }], new Date(0), new Map(), new Set(), /re/,
    ];
    const out = migrate({ threads: [junk[0], keepFirst, ...junk.slice(1), keepLast] });
    // keepLast is a note (and the only one), so it becomes order 0.
    assert.deepEqual(out.threads, [keepFirst, { ...keepLast, order: 0 }]);
  });

  it('keeps items with an empty object body, array-valued fields and so on', () => {
    const threads = [{ id: 'a', body: {}, tags: [], nested: { list: [null, undefined] } }];
    assert.deepEqual(migrate({ threads }).threads, threads);
  });

  it('does not pollute prototypes when the file contains a __proto__ key', () => {
    const hostile = JSON.parse('{"threads":[{"id":"a","__proto__":{"admin":true}}],"__proto__":{"polluted":true}}');
    const out = migrate(hostile);
    assert.equal(({}).polluted, undefined);
    assert.equal(({}).admin, undefined);
    assert.equal(Object.getPrototypeOf(out), Object.prototype);
    assert.equal(out.polluted, undefined);
    assert.equal(Object.getPrototypeOf(out.threads[0]), Object.prototype);
    assert.equal(out.threads[0].admin, undefined);
    // ...and the data itself is not lost, just kept inert.
    assert.ok(Object.hasOwn(out.threads[0], '__proto__'));
  });
});

describe('migrate: a note gets a manual order the first time a file needs one', () => {
  it('a file with no notes at all is untouched', () => {
    const threads = [item('a', 'dump'), item('b', 'axis')];
    assert.deepEqual(migrate({ threads }).threads, threads);
  });

  it('several notes with no order are numbered 0..n-1 by today\'s "newest edited first" rule', () => {
    const threads = [
      item('oldest', 'note', { createdAt: 100, updatedAt: 100 }),
      item('newest', 'note', { createdAt: 300, updatedAt: 300 }),
      item('middle', 'note', { createdAt: 200, updatedAt: 200 }),
    ];
    const out = migrate({ threads }).threads;
    const orderOf = (id) => out.find((t) => t.id === id).order;
    assert.equal(orderOf('newest'), 0);
    assert.equal(orderOf('middle'), 1);
    assert.equal(orderOf('oldest'), 2);
  });

  it('a note with no updatedAt falls back to createdAt, exactly like the screen it is seeding for', () => {
    const threads = [
      item('has-createdAt-only', 'note', { createdAt: 100 }),
      item('edited-more-recently', 'note', { createdAt: 50, updatedAt: 200 }),
    ];
    const out = migrate({ threads }).threads;
    assert.equal(out.find((t) => t.id === 'edited-more-recently').order, 0);
    assert.equal(out.find((t) => t.id === 'has-createdAt-only').order, 1);
  });

  it('notes and tasks are ranked separately: a task never gets an order, and is not counted against the notes', () => {
    const threads = [item('task1', 'dump'), item('note1', 'note'), item('task2', 'axis'), item('note2', 'note')];
    const out = migrate({ threads }).threads;
    assert.ok(!('order' in out.find((t) => t.id === 'task1')));
    assert.ok(!('order' in out.find((t) => t.id === 'task2')));
    assert.deepEqual([out.find((t) => t.id === 'note1').order, out.find((t) => t.id === 'note2').order].sort(), [0, 1]);
  });

  it('if every note already has a finite order, none of them are touched — including a manual, non-time-based one', () => {
    const threads = [
      item('a', 'note', { createdAt: 500, order: 2 }), // deliberately NOT what newest-first would pick
      item('b', 'note', { createdAt: 100, order: 0 }),
      item('c', 'note', { createdAt: 300, order: 1 }),
    ];
    assert.deepEqual(migrate({ threads }).threads, threads);
  });

  it('if even one note lacks an order, the WHOLE group is renumbered by time (a state this app never produces itself)', () => {
    const threads = [
      item('has-one', 'note', { createdAt: 100, order: 99 }), // its old manual position is not preserved
      item('lacks-one', 'note', { createdAt: 200 }),
    ];
    const out = migrate({ threads }).threads;
    assert.equal(out.find((t) => t.id === 'lacks-one').order, 0); // newer, so first
    assert.equal(out.find((t) => t.id === 'has-one').order, 1);
  });

  it('a non-finite order (NaN, a string, Infinity) counts as no order at all', () => {
    for (const bad of [NaN, '3', Infinity, -Infinity, null]) {
      const threads = [item('a', 'note', { order: bad })];
      assert.equal(migrate({ threads }).threads[0].order, 0, JSON.stringify(bad));
    }
  });

  it('is idempotent on its own: migrating an already-seeded notes group changes nothing', () => {
    const threads = [item('a', 'note', { createdAt: 100 }), item('b', 'note', { createdAt: 200 })];
    const once = migrate({ threads }).threads;
    assert.deepEqual(migrate({ threads: once }).threads, once);
  });

  it('touches only the `order` field: every other field on a note survives untouched', () => {
    const threads = [item('a', 'note', { body: 'text', linkTitle: 'A Title', updatedAt: 42, futureField: { x: 1 } })];
    const out = migrate({ threads }).threads[0];
    assert.equal(out.body, 'text');
    assert.equal(out.linkTitle, 'A Title');
    assert.equal(out.updatedAt, 42);
    assert.deepEqual(out.futureField, { x: 1 });
    assert.equal(out.order, 0);
  });
});

describe('migrate: stats', () => {
  const threads = () => [item('a', 'axis'), item('b', 'done', { doneAt: 5 }), item('n', 'note'), item('c', 'dump')];
  const seeded = { listed: 3, done: 1 }; // a, b and c are tasks; the note is not "listed"

  const kept = [
    ['zeros', { listed: 0, done: 0 }],
    ['ordinary counts', { listed: 5, done: 2 }],
    ['counts that disagree with the threads on disk', { listed: 9, done: 4 }],
    ['large counts', { listed: 1e9, done: 0 }],
    ['extra fields', { listed: 3, done: 1, streak: 7 }],
  ];
  for (const [name, stats] of kept) {
    it(`keeps valid stats: ${name}`, () => {
      assert.deepEqual(migrate({ version: 2, threads: threads(), stats, history: [] }).stats, stats);
    });
  }

  const reseeded = [
    ['a negative listed', { listed: -1, done: 0 }],
    ['a negative done', { listed: 1, done: -1 }],
    ['a fractional count', { listed: 1.5, done: 0 }],
    ['NaN', { listed: NaN, done: 0 }],
    ['Infinity', { listed: Infinity, done: 0 }],
    ['numeric strings', { listed: '3', done: '1' }],
    ['a null field', { listed: null, done: 1 }],
    ['a missing done', { listed: 3 }],
    ['a missing listed', { done: 1 }],
    ['an empty object', {}],
    ['null', null],
    ['undefined', undefined],
    ['an array', [3, 1]],
    ['a number', 5],
    ['a string', 'stats'],
    ['true', true],
  ];
  for (const [name, stats] of reseeded) {
    it(`seeds from the threads when stats are ${name}`, () => {
      assert.deepEqual(migrate({ threads: threads(), stats }).stats, seeded);
    });
  }

  it('seeds listed as every item that is not a note, and done as every done item', () => {
    const many = [
      item('1', 'dump'),
      item('2', 'axis'),
      item('3', 'resolving'),
      item('4', 'done'),
      item('5', 'done'),
      item('6', 'note'),
      item('7', 'note'),
      item('8', 'weird'),
      { id: '9' }, // no status: not a note, so it counts as listed
    ];
    assert.deepEqual(migrate({ threads: many }).stats, { listed: 7, done: 2 });
  });

  it('seeds from the entries it kept, not from the junk it dropped', () => {
    assert.deepEqual(migrate({ threads: [null, item('a', 'done'), 'x', [], item('n', 'note')] }).stats, { listed: 1, done: 1 });
  });

  it('a file made only of notes seeds zero listed', () => {
    assert.deepEqual(migrate({ threads: [item('n1', 'note'), item('n2', 'note')] }).stats, { listed: 0, done: 0 });
  });
});

describe('migrate: history', () => {
  const doneThread = { id: 'd', text: 'pay rent', quad: 3, status: 'done', createdAt: 400, doneAt: 950, body: 'x' };
  const stats = { listed: 1, done: 1 };

  it('keeps an array of entries as it is', () => {
    const history = [
      { id: 'h1', text: 'x', quad: 1, createdAt: 1, doneAt: 2 },
      { id: 'h2', extra: true },
      { id: 'h1', text: 'the same id again' },
    ];
    assert.deepEqual(migrate({ threads: [doneThread], stats, history }).history, history);
  });

  it('drops only the entries that are not plain objects', () => {
    const a = { id: 'h1' };
    const b = { id: 'h2' };
    const out = migrate({ threads: [], stats, history: [null, a, 5, 'x', [], undefined, b, true, new Date(0)] });
    assert.deepEqual(out.history, [a, b]);
  });

  it('keeps an empty array empty: it is a history, just a short one, not a missing one', () => {
    assert.deepEqual(migrate({ threads: [doneThread], stats, history: [] }).history, []);
  });

  const notArrays = [
    ['missing', undefined],
    ['null', null],
    ['a string', 'x'],
    ['a number', 5],
    ['true', true],
    ['an object', {}],
    ['an array-like', { 0: { id: 'x' }, length: 1 }],
  ];
  for (const [name, history] of notArrays) {
    it(`seeds it from the done rows when it is ${name}`, () => {
      const out = migrate({ threads: [item('a', 'axis'), doneThread, item('n', 'note')], stats, history });
      assert.deepEqual(out.history, [{ id: 'd', text: 'pay rent', quad: 3, createdAt: 400, doneAt: 950 }]);
    });
  }

  it('seeds entries with exactly the five history fields, even for a done item missing some', () => {
    const bare = { id: 'z', status: 'done', text: 't', quad: 1, createdAt: 3 };
    const out = migrate({ threads: [bare] });
    assert.deepEqual(out.history, [toHistory(bare)]);
    assert.deepEqual(Object.keys(out.history[0]), ['id', 'text', 'quad', 'createdAt', 'doneAt']);
  });

  it('seeds nothing when no item is done', () => {
    assert.deepEqual(migrate({ threads: [item('a', 'axis'), item('n', 'note')] }).history, []);
  });
});

describe('migrate: version', () => {
  const stamped = [
    ['missing', undefined, 2],
    ['null', null, 2],
    ['0', 0, 2],
    ['1', 1, 2],
    ['-1', -1, 2],
    ['2', 2, 2],
    ['a string "1"', '1', 2],
    ['a string "3" (only a number can be a version)', '3', 2],
    ['NaN', NaN, 2],
    ['Infinity', Infinity, 2],
    ['true', true, 2],
    ['an object', {}, 2],
  ];
  for (const [name, version, expected] of stamped) {
    it(`${name} becomes ${expected}`, () => {
      assert.equal(migrate({ version, threads: [] }).version, expected);
    });
  }

  for (const version of [3, 4, 99]) {
    it(`version ${version}, written by a newer app, is never downgraded`, () => {
      assert.equal(migrate({ version, threads: [] }).version, version);
    });
  }

  it('a newer file that is otherwise valid comes back as an identical copy, except its unordered note gains an order', () => {
    const newer = {
      version: 3,
      threads: [item('a', 'done', { doneAt: 5, aiSummary: 'x' }), item('n', 'note', { tags: ['t'] })],
      stats: { listed: 4, done: 2 },
      history: [{ id: 'h', kind: 'from-v3' }],
      settings: { theme: 'dark' },
      tags: ['a', 'b'],
    };
    const out = migrate(newer);
    assert.deepEqual(out, { ...newer, threads: [newer.threads[0], { ...newer.threads[1], order: 0 }] });
    assert.notEqual(out, newer);
  });

  it('a newer file missing stats and history still gets them seeded, and keeps its version', () => {
    const out = migrate({ version: 3, threads: [item('a', 'done'), item('n', 'note')] });
    assert.equal(out.version, 3);
    assert.deepEqual(out.stats, { listed: 1, done: 1 });
    assert.equal(out.history.length, 1);
  });
});

describe('migrate: fields it does not know', () => {
  it('top-level fields ride along, so an older app cannot erase what a newer one wrote', () => {
    const out = migrate({ threads: [], settings: { theme: 'dark' }, tags: ['a'], lastSync: null });
    assert.deepEqual(out, { ...EMPTY(), settings: { theme: 'dark' }, tags: ['a'], lastSync: null });
  });

  it('the four known fields are always present and always win', () => {
    const out = migrate({ threads: [], version: 1, stats: 'bad', history: 'bad' });
    assert.deepEqual(out, EMPTY());
  });

  it('the result lists its fields in the documented order', () => {
    assert.deepEqual(Object.keys(migrate(v1File())), ['version', 'threads', 'stats', 'history']);
  });
});

describe('migrate: never touches its input, never shares memory with it', () => {
  const rich = () => ({
    version: 1,
    threads: [
      { id: 'a', status: 'done', text: 'a', createdAt: 1, doneAt: 2, meta: { tags: ['x', { deep: 1 }] } },
      { id: 'b', status: 'note', body: 'hello' },
      null,
    ],
    stats: { listed: 2, done: 1, extra: { n: 1 } },
    history: [{ id: 'a', nested: { z: 1 } }, 7],
    future: { deep: [1, 2, { three: 3 }] },
  });

  it('accepts a deeply frozen input, and returns something the caller may change', () => {
    const frozen = deepFreeze(rich());
    const out = migrate(frozen);
    assert.deepEqual(out.threads.map((t) => t.id), ['a', 'b']); // it really ran, not a swallowed error
    assert.equal(Object.isFrozen(out), false);
    assert.equal(Object.isFrozen(out.threads), false);
    assert.doesNotThrow(() => {
      out.threads.push({ id: 'c' });
      out.threads[0].meta.tags.push('y');
      out.stats.listed = 99;
    });
  });

  it('accepts sealed and non-extensible input', () => {
    const input = rich();
    Object.preventExtensions(input);
    Object.seal(input.threads);
    assert.equal(migrate(input).threads.length, 2);
  });

  it('leaves the input exactly as it was', () => {
    const input = rich();
    const before = structuredClone(input);
    migrate(input);
    assert.deepEqual(input, before);
    // Including when it has to seed and drop things.
    const bare = v1File();
    const bareBefore = structuredClone(bare);
    migrate(bare);
    assert.deepEqual(bare, bareBefore);
  });

  it('shares no object with the input, at any depth', () => {
    const input = rich();
    const out = migrate(input);
    assert.notEqual(out.threads, input.threads);
    assert.notEqual(out.threads[0], input.threads[0]);
    assert.notEqual(out.threads[0].meta, input.threads[0].meta);
    assert.notEqual(out.threads[0].meta.tags, input.threads[0].meta.tags);
    assert.notEqual(out.threads[0].meta.tags[1], input.threads[0].meta.tags[1]);
    assert.notEqual(out.stats, input.stats);
    assert.notEqual(out.stats.extra, input.stats.extra);
    assert.notEqual(out.history, input.history);
    assert.notEqual(out.history[0], input.history[0]);
    assert.notEqual(out.history[0].nested, input.history[0].nested);
    assert.notEqual(out.future, input.future);
    assert.notEqual(out.future.deep, input.future.deep);
  });

  it('changing the result never reaches the input', () => {
    const input = rich();
    const before = structuredClone(input);
    const out = migrate(input);
    out.threads[0].meta.tags.push('y');
    out.threads[0].text = 'changed';
    out.threads.push({ id: 'c' });
    out.stats.listed = 99;
    out.stats.extra.n = 2;
    out.history[0].nested.z = 2;
    out.history.push({ id: 'h' });
    out.future.deep.push(4);
    assert.deepEqual(input, before);
  });

  it('changing the input afterwards never reaches the result', () => {
    const input = rich();
    const out = migrate(input);
    const snapshot = structuredClone(out);
    input.threads[0].meta.tags.push('y');
    input.threads[0].text = 'changed';
    input.threads.push({ id: 'c' });
    input.stats.listed = 99;
    input.history[0].nested.z = 2;
    input.future.deep.push(4);
    assert.deepEqual(out, snapshot);
  });

  it('seeded stats and history are new objects too', () => {
    const input = v1File();
    const out = migrate(input);
    out.history[0].text = 'changed';
    out.stats.done = 99;
    assert.equal(input.threads[1].text, 'call mum');
    assert.deepEqual(migrate(v1File()).stats, { listed: 5, done: 2 });
  });
});

describe('migrate: idempotent', () => {
  const hostile = JSON.parse('{"threads":[{"id":"a","__proto__":{"admin":true}}],"__proto__":{"polluted":true}}');
  const inputs = [
    ['undefined', undefined],
    ['null', null],
    ['a number', 5],
    ['an array', []],
    ['an empty object', {}],
    ['threads that are not an array', { threads: 'x' }],
    ['a v1 file', v1File()],
    ['a v1 file with no threads', { version: 1, threads: [] }],
    ['a v2 file', { version: 2, threads: [item('a', 'axis')], stats: { listed: 1, done: 0 }, history: [] }],
    ['a newer file', { version: 3, threads: [item('a', 'note')], settings: { x: 1 } }],
    ['junk everywhere', { threads: [null, 1, item('a', 'done'), []], stats: 'bad', history: 'bad', version: '2' }],
    ['bad stats over notes and done items', { threads: [item('n', 'note'), item('d', 'done')], stats: { listed: -1, done: 0 } }],
    ['a done item with missing fields (seeds undefined history fields)', { threads: [{ id: 'x', status: 'done' }] }],
    ['a __proto__ key', hostile],
    ['fields it does not know', { threads: [{ id: 'a', unknown: [1, { z: null }] }], settings: { a: 1 } }],
  ];
  for (const [name, input] of inputs) {
    it(`migrate(migrate(x)) equals migrate(x) for ${name}`, () => {
      const once = migrate(input);
      assert.deepEqual(migrate(once), once);
      assert.deepEqual(migrate(migrate(once)), once);
    });
  }
});

// A seeded generator, so a failure reproduces exactly.
describe('migrate: properties over many generated states', () => {
  function mulberry32(seed) {
    let a = seed;
    return () => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const PRIMITIVES = [null, true, false, 0, 1, -1, 2, 3, 1.5, NaN, 'x', '', 'note', 'done', 'axis', 'dump', 'resolving'];
  const KEYS = ['threads', 'stats', 'history', 'version', 'listed', 'done', 'id', 'status', 'text', 'doneAt', 'createdAt', 'quad', 'body'];
  const STATUSES = ['dump', 'axis', 'resolving', 'done', 'note', 'weird', undefined];

  const isPlain = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
  const isCount = (n) => Number.isInteger(n) && n >= 0;

  it('any JSON-shaped state gives a valid v2 state, loses no plain-object entry, and is stable', () => {
    const random = mulberry32(20260921);
    const pick = (list) => list[Math.floor(random() * list.length)];

    const junk = (depth = 0) => {
      const roll = random();
      if (depth > 3 || roll < 0.35) return pick(PRIMITIVES);
      if (roll < 0.6) return Array.from({ length: Math.floor(random() * 4) }, () => junk(depth + 1));
      return Object.fromEntries(Array.from({ length: Math.floor(random() * 5) }, () => [pick(KEYS), junk(depth + 1)]));
    };
    const itemLike = () => ({
      id: `i${Math.floor(random() * 50)}`,
      status: pick(STATUSES),
      text: 'x',
      createdAt: Math.floor(random() * 1000),
      ...(random() < 0.3 ? { doneAt: 5 } : {}),
      ...(random() < 0.3 ? { unknown: junk(2) } : {}),
    });
    const stateLike = () => {
      const state = {};
      if (random() < 0.9) state.threads = Array.from({ length: Math.floor(random() * 7) }, () => (random() < 0.8 ? itemLike() : junk(2)));
      if (random() < 0.5) state.stats = random() < 0.5 ? { listed: Math.floor(random() * 9), done: Math.floor(random() * 9) } : junk(2);
      if (random() < 0.5) state.history = random() < 0.7 ? Array.from({ length: Math.floor(random() * 4) }, () => junk(2)) : junk(2);
      if (random() < 0.7) state.version = pick([undefined, 1, 2, 3, 7, 'x', null, -1, 2.5]);
      if (random() < 0.2) state.extra = junk(1);
      return state;
    };

    for (let n = 0; n < 3000; n++) {
      const input = random() < 0.15 ? junk() : stateLike();
      const before = structuredClone(input);
      const note = `#${n} ${JSON.stringify(input)}`;

      const out = migrate(input);

      assert.deepEqual(input, before, `${note}: input was modified`);
      // A valid v2-or-newer state...
      assert.ok(Number.isFinite(out.version) && out.version >= 2, note);
      assert.ok(Array.isArray(out.threads) && out.threads.every(isPlain), note);
      assert.ok(isPlain(out.stats) && isCount(out.stats.listed) && isCount(out.stats.done), note);
      assert.ok(Array.isArray(out.history) && out.history.every(isPlain), note);

      if (isPlain(input) && Array.isArray(input.threads)) {
        const plainInput = input.threads.filter(isPlain);
        // ...that lost no user data: every plain-object entry, unchanged, in the same position, in every
        // field EXCEPT a note's `order` (seedNoteOrder — none of this generator's items ever start with
        // one, so every note here gets freshly numbered; a dedicated test below covers "already has one").
        assert.equal(out.threads.length, plainInput.length, note);
        out.threads.forEach((outItem, i) => {
          const inItem = plainInput[i];
          const { order: outOrder, ...outRest } = outItem;
          const { order: inOrder, ...inRest } = inItem;
          assert.deepEqual(outRest, inRest, `${note}: item ${i} changed a field other than order`);
          if (inItem.status !== 'note') assert.equal(outOrder, inOrder, `${note}: item ${i} is not a note but its order changed`);
        });
        // Whatever the notes' new order values are, together they are exactly 0..n-1: no gaps, no
        // duplicates (true here because this generator never gives a note a starting order — see above).
        const noteOrders = out.threads.filter((t) => t.status === 'note').map((t) => t.order).sort((a, b) => a - b);
        assert.deepEqual(noteOrders, noteOrders.map((_, i) => i), note);
        // A newer app's version is never lowered.
        if (Number.isFinite(input.version) && input.version > 2) assert.equal(out.version, input.version, note);
      } else {
        assert.deepEqual(out, EMPTY(), note);
      }

      // ...and running it again changes nothing.
      assert.deepEqual(migrate(out), out, `${note}: not idempotent`);
    }
  });
});
