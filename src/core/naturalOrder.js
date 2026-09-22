// What order things are in before anyone has ever dragged anything. Shared by selectors.js (what the
// screen shows today) and migrate.js (backfilling a manual `order` the first time a file needs one), so
// both agree on what "note" and "newest first" mean instead of each keeping its own copy that could drift.
const time = (n) => (Number.isFinite(n) ? n : 0);

export const isNote = (t) => t.status === 'note';

// When a note was last touched; notes made before updatedAt existed fall back to the day they were created.
const editedAt = (t) => (Number.isFinite(t.updatedAt) ? t.updatedAt : time(t.createdAt));
// Plain < and > (not localeCompare) so the tie-break is the same on every machine.
const byIdAsc = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export const newestEditFirst = (a, b) =>
  editedAt(b) - editedAt(a) || time(b.createdAt) - time(a.createdAt) || byIdAsc(a, b);
