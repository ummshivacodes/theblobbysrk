import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createPersistence } = require('../../main/persistence.js');

// Every test works in its own directory under the OS temp dir; nothing else is touched.
const made = [];
after(() => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
});

function sandbox(name = 'threads.json') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blob-persistence-'));
  made.push(dir);
  return { dir, file: path.join(dir, name), at: (...parts) => path.join(dir, ...parts) };
}

// Local-time constructor, so the local date is the same whatever the timezone.
const localMs = (y, m, d, hour = 12, minute = 0, second = 0) => new Date(y, m - 1, d, hour, minute, second).getTime();
const TODAY = localMs(2026, 9, 21);

const sample = (n = 1) => ({
  version: 1,
  threads: [{ id: `t${n}`, text: `héllo ✓ ${n}`, status: 'dump', quad: null, createdAt: n }],
  stats: { listed: n, done: 0 },
  history: [],
});
const pretty = (data) => JSON.stringify(data, null, 2);
const read = (file) => fs.readFileSync(file, 'utf-8');
const listing = (dir) => fs.readdirSync(dir).sort();
const tmpFiles = (dir) => listing(dir).filter((name) => name.endsWith('.tmp'));

// The real fs with some functions replaced, plus a record of which file
// descriptors are still open (a failed save must not leak one).
function fsWith(overrides = {}) {
  const open = new Set();
  const wrapped = {
    ...fs,
    openSync: (...args) => {
      const fd = fs.openSync(...args);
      open.add(fd);
      return fd;
    },
    closeSync: (fd) => {
      open.delete(fd);
      return fs.closeSync(fd);
    },
    ...overrides,
  };
  return { fs: wrapped, open };
}

// A rename that works except when it is setting a file aside. Refusing only that
// (not every rename) matters: it leaves the write path healthy, so code that
// carried on and overwrote the unreadable file anyway would succeed and be caught.
const refuseQuarantine = (from, to) => {
  if (String(to).includes('.corrupt-')) throw new Error('EPERM');
  return fs.renameSync(from, to);
};

describe('createPersistence', () => {
  test('needs a filePath', () => {
    for (const args of [undefined, {}, { filePath: '' }, { filePath: 42 }, { filePath: null }]) {
      assert.throws(() => createPersistence(args), TypeError, JSON.stringify(args));
    }
  });

  test('defaults to the real clock and the real fs', () => {
    const { file, at } = sandbox();
    fs.writeFileSync(file, pretty(sample(1)));
    const p = createPersistence({ filePath: file });
    assert.equal(p.save(sample(2)), true);
    assert.equal(read(file), pretty(sample(2)));
    const dated = listing(at('backups'));
    assert.equal(dated.length, 1);
    assert.match(dated[0], /^threads-\d{4}-\d{2}-\d{2}\.json$/);
  });
});

describe('load', () => {
  test('a missing file is a fresh install: all null, and nothing is created', () => {
    const { dir, file, at } = sandbox();
    const p = createPersistence({ filePath: file, now: () => TODAY });
    assert.deepEqual(p.load(), { data: null, recoveredFrom: null, quarantined: null });
    assert.deepEqual(listing(dir), []);

    const deeper = createPersistence({ filePath: at('not', 'there', 'threads.json'), now: () => TODAY });
    assert.deepEqual(deeper.load(), { data: null, recoveredFrom: null, quarantined: null });
    assert.equal(fs.existsSync(at('not')), false);
  });

  test('a good file loads as it is, and loading changes nothing on disk', () => {
    const { dir, file } = sandbox();
    fs.writeFileSync(file, pretty(sample(3)));
    const p = createPersistence({ filePath: file, now: () => TODAY });
    assert.deepEqual(p.load(), { data: sample(3), recoveredFrom: null, quarantined: null });
    assert.deepEqual(listing(dir), ['threads.json']);
    assert.equal(read(file), pretty(sample(3)));

    fs.writeFileSync(file, '{}');
    assert.deepEqual(p.load(), { data: {}, recoveredFrom: null, quarantined: null });
  });

  test('a stale .tmp from an interrupted write is ignored', () => {
    const { dir, file, at } = sandbox();
    fs.writeFileSync(file, pretty(sample(1)));
    fs.writeFileSync(at('threads.json.tmp'), '{"half": "writ');
    const p = createPersistence({ filePath: file, now: () => TODAY });
    assert.deepEqual(p.load(), { data: sample(1), recoveredFrom: null, quarantined: null });
    assert.equal(read(at('threads.json.tmp')), '{"half": "writ', 'left exactly as it was');

    // Even a complete-looking .tmp is not adopted: nobody can tell the write finished.
    fs.rmSync(file);
    fs.writeFileSync(at('threads.json.tmp'), pretty(sample(9)));
    assert.deepEqual(p.load(), { data: null, recoveredFrom: null, quarantined: null });
    assert.deepEqual(listing(dir), ['threads.json.tmp']);
  });

  test('an unusable file is renamed aside with its bytes intact, never deleted', () => {
    const contents = ['', '   ', '{"threads": [', 'not json at all', 'null', '42', '"just text"', 'true', '{"a": 1}}'];
    for (const bytes of contents) {
      const { dir, file, at } = sandbox();
      fs.writeFileSync(file, bytes);
      const p = createPersistence({ filePath: file, now: () => 1750000000000 });
      const quarantined = at('threads.corrupt-1750000000000.json');
      assert.deepEqual(p.load(), { data: null, recoveredFrom: null, quarantined }, JSON.stringify(bytes));
      assert.equal(read(quarantined), bytes);
      assert.deepEqual(listing(dir), ['threads.corrupt-1750000000000.json'], 'the live file is gone, nothing else appeared');
    }
  });

  test('corrupt file and a good backup: recovered from the backup', () => {
    const { dir, file, at } = sandbox();
    fs.writeFileSync(file, '{"threads": [');
    fs.writeFileSync(at('threads.backup.json'), pretty(sample(7)));
    const p = createPersistence({ filePath: file, now: () => 1750000000000 });
    const quarantined = at('threads.corrupt-1750000000000.json');

    assert.deepEqual(p.load(), { data: sample(7), recoveredFrom: 'backup', quarantined });
    assert.equal(read(quarantined), '{"threads": [');
    assert.equal(read(at('threads.backup.json')), pretty(sample(7)), 'the backup itself is untouched');
    assert.deepEqual(listing(dir), ['threads.backup.json', 'threads.corrupt-1750000000000.json', 'threads.json']);
  });

  test('after a recovery the good copy is the live file again, so a reload or the next launch sees it', () => {
    const { file, at } = sandbox();
    fs.writeFileSync(file, 'garbage');
    fs.writeFileSync(at('threads.backup.json'), pretty(sample(7)));
    const p = createPersistence({ filePath: file, now: () => TODAY });
    assert.equal(p.load().recoveredFrom, 'backup');

    assert.equal(read(file), pretty(sample(7)));
    // A second load, and a brand new instance (the next launch), find it without any drama.
    assert.deepEqual(p.load(), { data: sample(7), recoveredFrom: null, quarantined: null });
    const next = createPersistence({ filePath: file, now: () => TODAY });
    assert.deepEqual(next.load(), { data: sample(7), recoveredFrom: null, quarantined: null });
  });

  test('corrupt file and corrupt backup: no data, and nothing is deleted', () => {
    const { dir, file, at } = sandbox();
    fs.writeFileSync(file, '{"threads": [1, 2');
    fs.writeFileSync(at('threads.backup.json'), 'also garbage');
    const p = createPersistence({ filePath: file, now: () => 1750000000000 });
    const quarantined = at('threads.corrupt-1750000000000.json');

    assert.deepEqual(p.load(), { data: null, recoveredFrom: null, quarantined });
    assert.equal(read(quarantined), '{"threads": [1, 2');
    assert.equal(read(at('threads.backup.json')), 'also garbage', 'the bad backup is not touched either');
    assert.deepEqual(listing(dir), ['threads.backup.json', 'threads.corrupt-1750000000000.json']);
  });

  test('corrupt file and no backup: no data, file still set aside', () => {
    const { file, at } = sandbox();
    fs.writeFileSync(file, '{oops');
    const p = createPersistence({ filePath: file, now: () => 1750000000000 });
    const result = p.load();
    assert.deepEqual(result, { data: null, recoveredFrom: null, quarantined: at('threads.corrupt-1750000000000.json') });
    assert.equal(read(result.quarantined), '{oops');
  });

  test('a file that cannot be read at all (a directory in its place) is treated like a corrupt one', () => {
    const { file, at } = sandbox();
    fs.mkdirSync(file);
    fs.writeFileSync(path.join(file, 'inside.txt'), 'kept');
    fs.writeFileSync(at('threads.backup.json'), pretty(sample(5)));
    const p = createPersistence({ filePath: file, now: () => 1750000000000 });

    const result = p.load();
    assert.deepEqual(result, { data: sample(5), recoveredFrom: 'backup', quarantined: at('threads.corrupt-1750000000000.json') });
    assert.equal(read(path.join(result.quarantined, 'inside.txt')), 'kept');
    assert.equal(read(file), pretty(sample(5)));
  });

  test('never renames onto an earlier quarantine file', () => {
    const { dir, file, at } = sandbox();
    fs.writeFileSync(at('threads.corrupt-1750000000000.json'), 'earlier casualty');
    fs.writeFileSync(at('threads.corrupt-1750000000001.json'), 'and another');
    fs.writeFileSync(file, 'later casualty');
    const p = createPersistence({ filePath: file, now: () => 1750000000000 });

    const { quarantined } = p.load();
    assert.equal(quarantined, at('threads.corrupt-1750000000002.json'));
    assert.equal(read(at('threads.corrupt-1750000000000.json')), 'earlier casualty');
    assert.equal(read(at('threads.corrupt-1750000000001.json')), 'and another');
    assert.equal(read(quarantined), 'later casualty');
    assert.equal(listing(dir).length, 3);
  });

  test('if the file cannot be set aside it is left alone, the backup is still returned, and load does not throw', () => {
    const { dir, file, at } = sandbox();
    fs.writeFileSync(file, '{"corrupt": ');
    fs.writeFileSync(at('threads.backup.json'), pretty(sample(2)));
    const { fs: refusing } = fsWith({ renameSync: refuseQuarantine });
    const p = createPersistence({ filePath: file, now: () => TODAY, fs: refusing });

    assert.deepEqual(p.load(), { data: sample(2), recoveredFrom: 'backup', quarantined: null });
    assert.equal(read(file), '{"corrupt": ', 'not overwritten by the restored copy');
    assert.deepEqual(listing(dir), ['threads.backup.json', 'threads.json']);
  });
});

describe('save: the file itself', () => {
  test('writes exactly JSON.stringify(data, null, 2) and returns true; load reads it back', () => {
    const { file } = sandbox();
    const data = { version: 1, threads: [{ id: 'a', text: 'ünï "quoted" \n newline ✓ 😀', quad: null }], stats: { listed: 1, done: 0 }, history: [] };
    const p = createPersistence({ filePath: file, now: () => TODAY });

    assert.equal(p.save(data), true);
    assert.equal(read(file), JSON.stringify(data, null, 2));
    assert.ok(read(file).includes('\n  "version": 1,'), 'two-space indent');
    assert.ok(!read(file).endsWith('\n'), 'no trailing newline, as before');
    assert.deepEqual(p.load(), { data, recoveredFrom: null, quarantined: null });
  });

  test('leaves no .tmp behind, and on a fresh install creates nothing but the file', () => {
    const { dir, file } = sandbox();
    const p = createPersistence({ filePath: file, now: () => TODAY });
    p.save(sample(1));
    assert.deepEqual(listing(dir), ['threads.json']);
    p.save(sample(2));
    p.save(sample(3));
    assert.deepEqual(tmpFiles(dir), []);
  });

  test('writes through a .tmp file with an fd (write, fsync, close) and renames it into place', () => {
    const { dir, file, at } = sandbox();
    const calls = [];
    const spy = { ...fs };
    for (const name of ['openSync', 'writeSync', 'fsyncSync', 'closeSync', 'renameSync']) {
      spy[name] = (...args) => {
        calls.push({ name, args });
        return fs[name](...args);
      };
    }

    createPersistence({ filePath: file, now: () => TODAY, fs: spy }).save(sample(1));

    assert.deepEqual(calls.map((c) => c.name), ['openSync', 'writeSync', 'fsyncSync', 'closeSync', 'renameSync']);
    assert.equal(calls[0].args[0], at('threads.json.tmp'));
    assert.deepEqual(calls[4].args, [at('threads.json.tmp'), file]);
    assert.deepEqual(listing(dir), ['threads.json']);
  });

  test('a write that comes up short is completed', () => {
    const { file, at } = sandbox();
    fs.writeFileSync(file, pretty(sample(1)));
    const { fs: trickling } = fsWith({
      writeSync: (fd, buffer, offset, length) => fs.writeSync(fd, buffer, offset, Math.min(length, 7)),
    });

    createPersistence({ filePath: file, now: () => TODAY, fs: trickling }).save(sample(2));
    assert.equal(read(file), pretty(sample(2)));
    assert.equal(read(at('threads.backup.json')), pretty(sample(1)));
  });

  test('replaces the file by rename (a new file), not by rewriting it in place', () => {
    const { file } = sandbox();
    fs.writeFileSync(file, pretty(sample(1)));
    const inodeBefore = fs.statSync(file).ino;
    createPersistence({ filePath: file, now: () => TODAY }).save(sample(2));
    assert.notEqual(fs.statSync(file).ino, inodeBefore);
    assert.equal(read(file), pretty(sample(2)));
  });

  test('creates the directory if needed', () => {
    const { at } = sandbox();
    const nested = at('a', 'b', 'c', 'threads.json');
    createPersistence({ filePath: nested, now: () => TODAY }).save(sample(1));
    assert.equal(read(nested), pretty(sample(1)));
  });

  test('a stale .tmp does not get in the way, and is gone afterwards', () => {
    const { dir, file, at } = sandbox();
    fs.writeFileSync(at('threads.json.tmp'), 'left over from a crash');
    createPersistence({ filePath: file, now: () => TODAY }).save(sample(1));
    assert.equal(read(file), pretty(sample(1)));
    assert.deepEqual(listing(dir), ['threads.json']);
  });

  test('only objects can be saved: anything else would load back as corrupt', () => {
    const { dir, file } = sandbox();
    fs.writeFileSync(file, pretty(sample(1)));
    const p = createPersistence({ filePath: file, now: () => TODAY });
    for (const bad of [null, undefined, 'text', 42, true, () => {}, Symbol('x'), 10n, { toJSON: () => undefined }]) {
      assert.throws(() => p.save(bad), TypeError, String(typeof bad));
    }
    assert.equal(read(file), pretty(sample(1)));
    assert.deepEqual(listing(dir), ['threads.json']);
  });

  test('data that cannot be serialised throws before anything on disk is touched', () => {
    const { dir, file, at } = sandbox();
    fs.writeFileSync(file, pretty(sample(1)));
    const p = createPersistence({ filePath: file, now: () => TODAY });

    const circular = { name: 'loop' };
    circular.self = circular;
    assert.throws(() => p.save(circular), TypeError);
    assert.throws(() => p.save({ big: 10n }), TypeError);

    assert.equal(read(file), pretty(sample(1)));
    assert.deepEqual(listing(dir), ['threads.json'], 'no .tmp, no backups directory');

    // Not even the directory is created for data that was never going to be written.
    const fresh = createPersistence({ filePath: at('nope', 'threads.json'), now: () => TODAY });
    assert.throws(() => fresh.save(circular), TypeError);
    assert.equal(fs.existsSync(at('nope')), false);
  });
});

describe('save: backups', () => {
  test('the first save of a run keeps the PREVIOUS content as the backup and as today\'s dated copy', () => {
    const { file, at } = sandbox();
    const before = pretty(sample(1));
    fs.writeFileSync(file, before);
    const p = createPersistence({ filePath: file, now: () => TODAY });

    p.save(sample(2));
    assert.equal(read(file), pretty(sample(2)));
    assert.equal(read(at('threads.backup.json')), before);
    assert.equal(read(at('backups', 'threads-2026-09-21.json')), before);

    // Later saves the same day leave both as they were.
    p.save(sample(3));
    p.save(sample(4));
    assert.equal(read(file), pretty(sample(4)));
    assert.equal(read(at('threads.backup.json')), before);
    assert.equal(read(at('backups', 'threads-2026-09-21.json')), before);
    assert.deepEqual(listing(at('backups')), ['threads-2026-09-21.json'], 'and no .tmp in there');
  });

  test('a new run on the same day refreshes the backup but keeps the day\'s first dated copy', () => {
    const { file, at } = sandbox();
    fs.writeFileSync(file, pretty(sample(1)));
    createPersistence({ filePath: file, now: () => TODAY }).save(sample(2));

    createPersistence({ filePath: file, now: () => TODAY + 3600 * 1000 }).save(sample(3));
    assert.equal(read(at('threads.backup.json')), pretty(sample(2)), 'the state the second run started from');
    assert.equal(read(at('backups', 'threads-2026-09-21.json')), pretty(sample(1)), 'first of the day is kept');
  });

  test('dated copies are named by the local date, zero-padded', () => {
    // Early and late in the local day: in any timezone but UTC one of these is a different UTC date.
    for (const [hour, minute] of [[0, 30], [23, 30]]) {
      const { file, at } = sandbox();
      fs.writeFileSync(file, pretty(sample(1)));
      createPersistence({ filePath: file, now: () => localMs(2026, 1, 5, hour, minute) }).save(sample(2));
      assert.deepEqual(listing(at('backups')), ['threads-2026-01-05.json'], `${hour}:${minute}`);
    }
  });

  test('a save after the date changes makes a new dated copy, once per day', () => {
    const { file, at } = sandbox();
    let clock = localMs(2026, 9, 21, 9);
    const p = createPersistence({ filePath: file, now: () => clock });
    fs.writeFileSync(file, pretty(sample(1)));

    p.save(sample(2));
    clock = localMs(2026, 9, 21, 23, 59, 59);  // still the same local day
    p.save(sample(3));
    assert.deepEqual(listing(at('backups')), ['threads-2026-09-21.json']);
    assert.equal(read(at('backups', 'threads-2026-09-21.json')), pretty(sample(1)));

    clock = localMs(2026, 9, 22, 0, 0, 1);     // just after midnight
    p.save(sample(4));
    assert.deepEqual(listing(at('backups')), ['threads-2026-09-21.json', 'threads-2026-09-22.json']);
    assert.equal(read(at('backups', 'threads-2026-09-22.json')), pretty(sample(3)), 'the state as the new day began');
    assert.equal(read(at('backups', 'threads-2026-09-21.json')), pretty(sample(1)), 'yesterday\'s is untouched');
    assert.equal(read(at('threads.backup.json')), pretty(sample(3)));

    p.save(sample(5));                          // and not again the same day
    assert.equal(read(at('backups', 'threads-2026-09-22.json')), pretty(sample(3)));
    assert.equal(read(at('threads.backup.json')), pretty(sample(3)));
  });

  test('on a fresh install the first save has nothing to back up, and that counts as the first save', () => {
    const { dir, file } = sandbox();
    let clock = TODAY;
    const p = createPersistence({ filePath: file, now: () => clock });
    p.save(sample(1));
    p.save(sample(2));
    assert.deepEqual(listing(dir), ['threads.json']);

    clock = localMs(2026, 9, 22, 8);
    p.save(sample(3));
    assert.deepEqual(listing(dir), ['backups', 'threads.backup.json', 'threads.json']);
  });

  test('rotation keeps exactly the newest 14 dated copies, and only ours', () => {
    const { file, at } = sandbox();
    fs.writeFileSync(file, pretty(sample(1)));
    fs.mkdirSync(at('backups'));
    const two = (n) => String(n).padStart(2, '0');
    for (let d = 1; d <= 20; d += 1) fs.writeFileSync(at('backups', `threads-2026-08-${two(d)}.json`), `old ${d}`);
    const decoys = ['other-2026-08-01.json', 'threads-notes.json', 'threads-2026-08-01.json.tmp', 'threads-2026-8-1.json',
      'threads-old-2026-08-01.json', 'README.txt'];
    for (const name of decoys) fs.writeFileSync(at('backups', name), 'not ours');

    createPersistence({ filePath: file, now: () => TODAY }).save(sample(2));

    const dated = listing(at('backups')).filter((name) => /^threads-\d{4}-\d{2}-\d{2}\.json$/.test(name));
    const expected = [];
    for (let d = 8; d <= 20; d += 1) expected.push(`threads-2026-08-${two(d)}.json`);
    expected.push('threads-2026-09-21.json');
    assert.equal(dated.length, 14);
    assert.deepEqual(dated, expected, 'the 13 newest old ones plus today\'s');
    for (const name of decoys) assert.equal(read(at('backups', name)), 'not ours', `${name} left alone`);
    assert.equal(read(at('backups', 'threads-2026-09-21.json')), pretty(sample(1)));
  });

  test('with 14 or fewer dated copies nothing is pruned', () => {
    const { file, at } = sandbox();
    fs.writeFileSync(file, pretty(sample(1)));
    fs.mkdirSync(at('backups'));
    for (let d = 1; d <= 13; d += 1) fs.writeFileSync(at('backups', `threads-2026-09-${String(d).padStart(2, '0')}.json`), 'x');
    createPersistence({ filePath: file, now: () => TODAY }).save(sample(2));
    assert.equal(listing(at('backups')).length, 14);
    assert.ok(fs.existsSync(at('backups', 'threads-2026-09-01.json')));
  });

  test('file names follow the name of the file (the THREAD_AXIS_DATA override, or no .json at all)', () => {
    const scratch = sandbox('scratch.json');
    fs.writeFileSync(scratch.file, pretty(sample(1)));
    createPersistence({ filePath: scratch.file, now: () => TODAY }).save(sample(2));
    assert.deepEqual(listing(scratch.dir), ['backups', 'scratch.backup.json', 'scratch.json']);
    assert.deepEqual(listing(scratch.at('backups')), ['scratch-2026-09-21.json']);

    const bare = sandbox('data');
    fs.writeFileSync(bare.file, pretty(sample(1)));
    createPersistence({ filePath: bare.file, now: () => TODAY }).save(sample(2));
    assert.deepEqual(listing(bare.dir), ['backups', 'data', 'data.backup.json']);
    assert.deepEqual(listing(bare.at('backups')), ['data-2026-09-21.json']);
  });

  test('a failing backup never stops the save, and is tried again on the next one', () => {
    const { dir, file, at } = sandbox();
    fs.writeFileSync(file, pretty(sample(1)));
    fs.writeFileSync(at('backups'), 'a file where the directory should go');
    const p = createPersistence({ filePath: file, now: () => TODAY });

    assert.equal(p.save(sample(2)), true);
    assert.equal(read(file), pretty(sample(2)));
    assert.equal(read(at('threads.backup.json')), pretty(sample(1)));
    assert.deepEqual(tmpFiles(dir), []);

    fs.rmSync(at('backups'));
    assert.equal(p.save(sample(3)), true);
    assert.equal(read(at('backups', 'threads-2026-09-21.json')), pretty(sample(2)), 'the retry backed up what was there');
  });
});

describe('save: when the write fails', () => {
  for (const failing of ['openSync', 'writeSync', 'fsyncSync', 'renameSync']) {
    test(`${failing} throwing: the original is untouched, the .tmp is removed, no fd is left open, the error comes out`, () => {
      const { dir, file } = sandbox();
      fs.writeFileSync(file, pretty(sample(1)));
      const { fs: broken, open } = fsWith({ [failing]: () => { throw new Error(`disk says no (${failing})`); } });
      const p = createPersistence({ filePath: file, now: () => TODAY, fs: broken });

      assert.throws(() => p.save(sample(2)), new RegExp(`disk says no \\(${failing}\\)`));
      assert.equal(read(file), pretty(sample(1)));
      assert.deepEqual(tmpFiles(dir), []);
      assert.equal(open.size, 0, 'a file descriptor leaked');
      assert.deepEqual(listing(dir), ['threads.json'], 'and the failed backup attempts left nothing either');
    });
  }

  test('a rename that fails only for the live file: the original stays, and the backup made just before is intact', () => {
    const { dir, file, at } = sandbox();
    fs.writeFileSync(file, pretty(sample(1)));
    const { fs: broken } = fsWith({
      renameSync: (from, to) => {
        if (to === file) throw new Error('cannot replace');
        return fs.renameSync(from, to);
      },
    });
    const p = createPersistence({ filePath: file, now: () => TODAY, fs: broken });

    assert.throws(() => p.save(sample(2)), /cannot replace/);
    assert.equal(read(file), pretty(sample(1)));
    assert.equal(read(at('threads.backup.json')), pretty(sample(1)));
    assert.deepEqual(tmpFiles(dir), []);
    assert.deepEqual(tmpFiles(at('backups')), []);
  });

  test('after a failed save the next one works', () => {
    const { file } = sandbox();
    fs.writeFileSync(file, pretty(sample(1)));
    let broken = true;
    const { fs: flaky } = fsWith({
      renameSync: (from, to) => {
        if (broken) throw new Error('not now');
        return fs.renameSync(from, to);
      },
    });
    const p = createPersistence({ filePath: file, now: () => TODAY, fs: flaky });

    assert.throws(() => p.save(sample(2)), /not now/);
    broken = false;
    assert.equal(p.save(sample(3)), true);
    assert.equal(read(file), pretty(sample(3)));
  });
});

describe('never overwrite a file we could not read', () => {
  test('a corrupt live file met at the first save is set aside, then replaced', () => {
    const { dir, file, at } = sandbox();
    fs.writeFileSync(file, '{"oops');
    const p = createPersistence({ filePath: file, now: () => 1750000000000 });

    assert.equal(p.save(sample(1)), true);
    assert.equal(read(file), pretty(sample(1)));
    assert.equal(read(at('threads.corrupt-1750000000000.json')), '{"oops');
    assert.equal(fs.existsSync(at('threads.backup.json')), false, 'garbage is never copied over the backup');
    assert.deepEqual(tmpFiles(dir), []);
  });

  test('if it cannot be set aside, save refuses and the file is left exactly as it was', () => {
    const { dir, file } = sandbox();
    fs.writeFileSync(file, '{"oops');
    const { fs: refusing } = fsWith({ renameSync: refuseQuarantine });
    const p = createPersistence({ filePath: file, now: () => TODAY, fs: refusing });

    assert.throws(() => p.save(sample(1)), /refusing to overwrite/);
    assert.equal(read(file), '{"oops');
    assert.deepEqual(listing(dir), ['threads.json']);
  });

  test('a torn write from the old code is recovered from, end to end', () => {
    const { dir, file, at } = sandbox();
    // Yesterday's run left a good file; today's first save keeps a copy of it.
    fs.writeFileSync(file, pretty(sample(1)));
    const run1 = createPersistence({ filePath: file, now: () => TODAY });
    run1.save(sample(2));

    // The app dies mid-write in the old, in-place way: half a file.
    fs.writeFileSync(file, pretty(sample(3)).slice(0, 40));

    // The next launch: loads the backup, keeps the wreck, and carries on.
    const run2 = createPersistence({ filePath: file, now: () => TODAY + 1000 });
    const loaded = run2.load();
    assert.equal(loaded.recoveredFrom, 'backup');
    assert.deepEqual(loaded.data, sample(1));
    assert.equal(read(loaded.quarantined), pretty(sample(3)).slice(0, 40));

    run2.save(sample(4));
    assert.equal(read(file), pretty(sample(4)));
    assert.equal(fs.existsSync(loaded.quarantined), true, 'the wreck is still there for a human');
    assert.deepEqual(tmpFiles(dir), []);
    assert.equal(fs.existsSync(at('backups')), true);
  });
});

describe('validate: a file that parses but is not a state counts as unreadable', () => {
  // What main.js passes: the renderer ignores a file without a threads array, starts empty, and the
  // next save would silently overwrite it.
  const hasThreads = (d) => Array.isArray(d.threads);
  const persistenceFor = (file, extra = {}) => createPersistence({
    filePath: file, now: () => 1750000000000, validate: hasThreads, ...extra,
  });

  test('a real state loads as usual', () => {
    const { file } = sandbox();
    fs.writeFileSync(file, pretty(sample(1)));
    assert.deepEqual(persistenceFor(file).load(), { data: sample(1), recoveredFrom: null, quarantined: null });
  });

  test('JSON that is an object but not a state is set aside, bytes intact, like invalid JSON', () => {
    for (const bytes of ['{"foo":1}', '{}', '{"threads": "nope"}', '{"threads": null}', '{"threads": {}}', '[]', '[1, 2]']) {
      const { dir, file, at } = sandbox();
      fs.writeFileSync(file, bytes);
      const quarantined = at('threads.corrupt-1750000000000.json');
      assert.deepEqual(persistenceFor(file).load(), { data: null, recoveredFrom: null, quarantined }, bytes);
      assert.equal(read(quarantined), bytes);
      assert.deepEqual(listing(dir), ['threads.corrupt-1750000000000.json']);
    }
  });

  test('it falls back to a good backup, and the good copy becomes the live file again', () => {
    const { file, at } = sandbox();
    fs.writeFileSync(file, '{"foo":1}');
    fs.writeFileSync(at('threads.backup.json'), pretty(sample(4)));
    const quarantined = at('threads.corrupt-1750000000000.json');

    assert.deepEqual(persistenceFor(file).load(), { data: sample(4), recoveredFrom: 'backup', quarantined });
    assert.equal(read(quarantined), '{"foo":1}');
    assert.equal(read(file), pretty(sample(4)));
  });

  test('a backup that is not a state is not used either, and is left alone', () => {
    const { dir, file, at } = sandbox();
    fs.writeFileSync(file, '{"oops');
    fs.writeFileSync(at('threads.backup.json'), '{"foo":1}');
    const quarantined = at('threads.corrupt-1750000000000.json');

    assert.deepEqual(persistenceFor(file).load(), { data: null, recoveredFrom: null, quarantined });
    assert.equal(read(at('threads.backup.json')), '{"foo":1}');
    assert.deepEqual(listing(dir), ['threads.backup.json', 'threads.corrupt-1750000000000.json']);
  });

  test('saving over such a file sets it aside and never copies it over a good backup', () => {
    const { dir, file, at } = sandbox();
    fs.writeFileSync(file, '{"foo":1}');
    fs.writeFileSync(at('threads.backup.json'), pretty(sample(1)));
    const quarantined = at('threads.corrupt-1750000000000.json');

    assert.equal(persistenceFor(file).save(sample(2)), true);
    assert.equal(read(file), pretty(sample(2)));
    assert.equal(read(quarantined), '{"foo":1}');
    assert.equal(read(at('threads.backup.json')), pretty(sample(1)), 'the good backup is still the good one');
    assert.deepEqual(listing(dir), ['threads.backup.json', 'threads.corrupt-1750000000000.json', 'threads.json'], 'no dated copy of it either');
  });

  test('a good live file is still backed up as before', () => {
    const { file, at } = sandbox();
    fs.writeFileSync(file, pretty(sample(1)));
    persistenceFor(file, { now: () => TODAY }).save(sample(2));
    assert.equal(read(at('threads.backup.json')), pretty(sample(1)));
    assert.equal(read(at('backups', 'threads-2026-09-21.json')), pretty(sample(1)));
  });

  test('save refuses data that is not a state, and leaves the file alone', () => {
    const { dir, file } = sandbox();
    fs.writeFileSync(file, pretty(sample(1)));
    const p = persistenceFor(file);
    for (const bad of [{ foo: 1 }, {}, { threads: 'nope' }, { threads: null }]) {
      assert.throws(() => p.save(bad), TypeError, JSON.stringify(bad));
    }
    assert.equal(read(file), pretty(sample(1)));
    assert.deepEqual(listing(dir), ['threads.json']);
    assert.equal(p.save(sample(3)), true, 'a real state still saves');
  });

  test('validate only ever sees objects, and one that throws counts as a no', () => {
    const seen = [];
    const spy = (d) => { seen.push(d); return true; };
    for (const bytes of ['null', '42', '"text"', 'true']) {
      const { file } = sandbox();
      fs.writeFileSync(file, bytes);
      persistenceFor(file, { validate: spy }).load();
    }
    assert.deepEqual(seen, [], 'never called with a non-object');

    const { file, at } = sandbox();
    fs.writeFileSync(file, pretty(sample(1)));
    persistenceFor(file, { validate: spy }).load();
    assert.deepEqual(seen, [sample(1)]);

    const boom = () => { throw new Error('validator bug'); };
    const throwing = persistenceFor(file, { validate: boom });
    assert.deepEqual(throwing.load(), { data: null, recoveredFrom: null, quarantined: at('threads.corrupt-1750000000000.json') });
    assert.throws(() => throwing.save(sample(2)), /not a valid state/);
  });

  test('without a validate, any object is a state, as before', () => {
    const { file } = sandbox();
    fs.writeFileSync(file, '{"foo":1}');
    const p = createPersistence({ filePath: file, now: () => TODAY });
    assert.deepEqual(p.load(), { data: { foo: 1 }, recoveredFrom: null, quarantined: null });
    assert.equal(p.save({ anything: true }), true);
  });
});
