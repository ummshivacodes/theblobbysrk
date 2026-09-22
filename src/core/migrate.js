// migrate(saved) -> state v2: the gate every loaded threads.json passes through.
// Its promises, each pinned by a unit test:
//   - total: it never throws, whatever it is given;
//   - lossless: every plain-object item survives with all its EXISTING fields (unknown ones included);
//     nothing already there is dropped, invented out of nothing, renumbered or re-statused. Structural
//     completeness that was never a meaningful fact about the item is a different thing: `stats`/`history`
//     are seeded whole when absent (seedStats/seedHistory), and a note's manual `order` is seeded the same
//     way the first time a file needs one (seedNoteOrder) — filling in "where does this sort", not changing
//     anything the file already said about the item;
//   - isolated: the result shares no memory with the input, and the input is
//     never touched;
//   - idempotent: migrating a migrated state changes nothing.
import { toHistory } from './history.js';
import { isNote, newestEditFirst } from './naturalOrder.js';

const SCHEMA_VERSION = 2;

const emptyState = () => ({
  version: SCHEMA_VERSION,
  threads: [],
  stats: { listed: 0, done: 0 },
  history: [],
});

// Only ever asked about clones (see snapshot), which are always built in this
// realm, so comparing with this realm's Object.prototype is safe even when the
// input came from another one. Arrays, dates and maps are not plain.
const isPlainObject = (value) =>
  value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;

const isCount = (n) => Number.isInteger(n) && n >= 0;

// The one step that touches caller-owned data, so the only one that can throw:
// functions, symbols, proxies and throwing getters cannot be cloned. None of
// those can come out of a JSON file, so they are treated like any other
// unusable input. Everything after this runs on inert clones.
function snapshot(saved) {
  try {
    return structuredClone(saved);
  } catch {
    return undefined;
  }
}

// Files from before the scoreboard existed have no stats: rebuild them from
// what is on disk. Notes were never tasks, so they are never "listed".
const seedStats = (threads) => ({
  listed: threads.filter((t) => t.status !== 'note').length,
  done: threads.filter((t) => t.status === 'done').length,
});

// Files from before the history list existed: seed it from the done rows.
const seedHistory = (threads) => threads.filter((t) => t.status === 'done').map(toHistory);

// Notes get a manual order (drag-and-drop) the first time a file needs one. If every note already has a
// finite numeric `order`, they are left exactly as they are — including relative to each other, so a
// second migrate() changes nothing (idempotent). Otherwise the WHOLE notes group is renumbered 0, 1, 2, …
// in today's order (newest-edited-first), so loading an old file — or one with only some notes numbered,
// which normal use of this app can never produce — changes nothing anyone SEES until they actually drag a
// note. Tasks don't get one yet: the task list isn't reorderable (see docs/REORDER-PLAN.md).
function seedNoteOrder(threads) {
  const notes = threads.filter(isNote);
  if (notes.every((t) => Number.isFinite(t.order))) return threads;
  const rankedIds = [...notes].sort(newestEditFirst).map((t) => t.id);
  return threads.map((t) => (isNote(t) ? { ...t, order: rankedIds.indexOf(t.id) } : t));
}

export function migrate(saved) {
  const data = snapshot(saved);
  if (!isPlainObject(data) || !Array.isArray(data.threads)) return emptyState();

  const { version, threads: allEntries, stats, history, ...unknown } = data;
  // Junk entries (null, numbers, strings, arrays) are the only thing dropped.
  const threads = seedNoteOrder(allEntries.filter(isPlainObject));

  return {
    // A newer app's version is never lowered, or it would migrate its own file again.
    version: Number.isFinite(version) && version > SCHEMA_VERSION ? version : SCHEMA_VERSION,
    threads,
    stats: isPlainObject(stats) && isCount(stats.listed) && isCount(stats.done) ? stats : seedStats(threads),
    history: Array.isArray(history) ? history.filter(isPlainObject) : seedHistory(threads),
    // Top-level fields only a newer app understands ride along untouched.
    ...unknown,
  };
}
