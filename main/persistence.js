// threads.json on disk, made hard to lose. Plain Node, and it knows nothing about
// what the data means: it is handed a path (and, under test, a clock and a fake fs).
//
// Why it exists: the old code wrote the file in place, so a crash mid-write left
// half a file; the next launch read nothing, started empty, and the next save
// overwrote what was left. Here a save goes to a .tmp file and is renamed over
// the real one (the real file is always the old version or the new one), a good
// copy is kept before each run's first save and once a day, and a file we
// cannot read is set aside, never overwritten and never deleted. "Cannot read"
// includes a file that parses but is not a state the app understands (see
// `validate`): the app would ignore it, start empty, and the next save would
// destroy it.
//
// Files, for filePath = /x/threads.json:
//   /x/threads.json.tmp                  transient write target
//   /x/threads.backup.json               copy of the last known-good file
//   /x/backups/threads-YYYY-MM-DD.json   one per day (local date), newest 14 kept
//   /x/threads.corrupt-<epochMs>.json    an unreadable file, kept for a human to look at

const path = require('node:path');

const KEEP_DATED = 14;

const pad = (n) => String(n).padStart(2, '0');

function localDay(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// validate(data) -> boolean says whether parsed JSON is a state worth loading. It only ever
// sees a non-null object, so it can be as short as (d) => Array.isArray(d.threads). Without
// one, any object will do.
function createPersistence({ filePath, now = Date.now, fs = require('node:fs'), validate = () => true } = {}) {
  if (typeof filePath !== 'string' || filePath === '') {
    throw new TypeError('createPersistence: filePath is required');
  }
  const dir = path.dirname(filePath);
  const stem = path.basename(filePath, '.json');
  const backupPath = path.join(dir, `${stem}.backup.json`);
  const datedDir = path.join(dir, 'backups');
  const datedPath = (day) => path.join(datedDir, `${stem}-${day}.json`);
  const quarantinePath = (ms) => path.join(dir, `${stem}.corrupt-${ms}.json`);
  const isDated = (name) => name.startsWith(`${stem}-`) && name.endsWith('.json')
    && /^\d{4}-\d{2}-\d{2}$/.test(name.slice(stem.length + 1, -'.json'.length));

  // The local day of the last finished backup step. null until this instance's
  // first save, which is what makes "first save of a run" and "the date changed"
  // the same check.
  let lastBackupDay = null;

  // Parsed JSON the app can use: an object that also passes validate. A validate
  // that throws counts as a no.
  function isUsable(data) {
    if (typeof data !== 'object' || data === null) return false;
    try {
      return Boolean(validate(data));
    } catch {
      return false;
    }
  }

  // { status: 'missing' } | { status: 'bad' } | { status: 'ok', text, data }.
  // 'bad' is anything the app could not use: unreadable, not JSON, or JSON that
  // is not a usable state.
  function inspect(file) {
    let text;
    try {
      text = fs.readFileSync(file, 'utf-8');
    } catch (err) {
      return { status: err && err.code === 'ENOENT' ? 'missing' : 'bad' };
    }
    try {
      const data = JSON.parse(text);
      if (isUsable(data)) return { status: 'ok', text, data };
    } catch {
      // not JSON: falls through to 'bad'
    }
    return { status: 'bad' };
  }

  // Write to <target>.tmp, fsync, rename over the target. A crash leaves the old
  // file whole; any failure removes the .tmp and rethrows.
  function writeAtomic(target, content) {
    const tmp = `${target}.tmp`;
    let fd = null;
    try {
      fd = fs.openSync(tmp, 'w');
      const bytes = Buffer.from(content, 'utf-8');
      let written = 0;
      while (written < bytes.length) written += fs.writeSync(fd, bytes, written, bytes.length - written);
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = null;
      fs.renameSync(tmp, target);
    } catch (err) {
      if (fd !== null) {
        try { fs.closeSync(fd); } catch { /* already failing */ }
      }
      try { fs.unlinkSync(tmp); } catch { /* may not exist */ }
      throw err;
    }
  }

  // Renames the live file to a fresh <stem>.corrupt-<ms>.json and returns that
  // path, or null if the OS refused. Renames rather than copies (instant, and it
  // clears the way), and never lands on an existing name: rename would silently
  // replace an earlier quarantine.
  function quarantine() {
    let ms = now();
    while (fs.existsSync(quarantinePath(ms))) ms += 1;
    const target = quarantinePath(ms);
    try {
      fs.renameSync(filePath, target);
      return target;
    } catch {
      return null;
    }
  }

  function pruneDated() {
    const dated = fs.readdirSync(datedDir).filter(isDated).sort();  // ISO dates: name order is date order
    for (const name of dated.slice(0, Math.max(0, dated.length - KEEP_DATED))) {
      try { fs.unlinkSync(path.join(datedDir, name)); } catch { /* the next run prunes again */ }
    }
  }

  // Before a save overwrites the live file, keep a good copy of it. Returns true
  // when the step is finished for today, false when a copy failed (tried again
  // on the next save). Throws only in the one case where saving would destroy
  // something: a live file we cannot read and cannot set aside.
  function protectExisting(day) {
    const live = inspect(filePath);
    if (live.status === 'missing') return true;   // nothing there yet
    if (live.status === 'bad') {
      // Same rule as load(): what we could not read is set aside, not overwritten.
      if (!quarantine()) throw new Error(`refusing to overwrite unreadable ${filePath}`);
      return true;
    }
    try {
      writeAtomic(backupPath, live.text);
      fs.mkdirSync(datedDir, { recursive: true });
      if (!fs.existsSync(datedPath(day))) writeAtomic(datedPath(day), live.text);
      pruneDated();
      return true;
    } catch {
      return false;   // a failing backup must never stop the user's edits being saved
    }
  }

  // { data, recoveredFrom, quarantined }. Never throws.
  //   live file missing        -> all null (a fresh install)
  //   live file good           -> { data }
  //   live file unusable       -> set it aside, then use the backup if that is good
  function load() {
    const live = inspect(filePath);
    if (live.status === 'missing') return { data: null, recoveredFrom: null, quarantined: null };
    if (live.status === 'ok') return { data: live.data, recoveredFrom: null, quarantined: null };

    const quarantined = quarantine();
    const backup = inspect(backupPath);
    if (backup.status !== 'ok') return { data: null, recoveredFrom: null, quarantined };

    // Put the good copy back as the live file, but only once the bad one is safely
    // aside. The store doesn't save right after loading, so without this a
    // recovery would leave no live file: a renderer reload or the next launch
    // would see "missing", start empty, and the save after that would put an
    // empty file in place of the backup's data.
    if (quarantined) {
      try { writeAtomic(filePath, backup.text); } catch { /* the data we return is still good */ }
    }
    return { data: backup.data, recoveredFrom: 'backup', quarantined };
  }

  // Throws (leaving disk untouched) if data can't be serialised; otherwise
  // returns true, or rethrows after cleaning up its .tmp if the write failed.
  function save(data) {
    // Only what load() would accept is ever written; anything else would come back as corrupt.
    if (!isUsable(data)) throw new TypeError('save: data is not a valid state');
    // First, so a circular or BigInt value fails before anything on disk changes.
    const json = JSON.stringify(data, null, 2);
    if (typeof json !== 'string') throw new TypeError('save: data is not serialisable');

    fs.mkdirSync(dir, { recursive: true });
    const day = localDay(now());
    if (day !== lastBackupDay && protectExisting(day)) lastBackupDay = day;
    writeAtomic(filePath, json);
    return true;
  }

  return { load, save };
}

module.exports = { createPersistence };
