// Read-side views of the state: pure functions that never mutate what they are
// given (each returns a fresh array, sorted stably) and that treat a state
// without a usable `threads` list as empty rather than crashing a render.

const isItem = (t) => t !== null && typeof t === 'object' && !Array.isArray(t);
const isNote = (t) => t.status === 'note';

// filter() also gives every caller its own array, so sorting it in place below
// can never reorder state.threads.
const items = (state) => (Array.isArray(state?.threads) ? state.threads.filter(isItem) : []);

// A missing or garbage timestamp sorts as oldest. Left as NaN it would make
// the comparator inconsistent, and the resulting order engine-defined.
const time = (n) => (Number.isFinite(n) ? n : 0);
const byCreatedAsc = (a, b) => time(a.createdAt) - time(b.createdAt);

// When a note was last touched; notes made before updatedAt existed fall back
// to the day they were created.
const editedAt = (t) => (Number.isFinite(t.updatedAt) ? t.updatedAt : time(t.createdAt));
// Plain < and > (not localeCompare) so the tie-break is the same on every machine.
const byIdAsc = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const newestEditFirst = (a, b) =>
  editedAt(b) - editedAt(a) || time(b.createdAt) - time(a.createdAt) || byIdAsc(a, b);

// What the blob shows, and the only items the axis draws.
export function activeThreads(state) {
  return items(state)
    .filter((t) => t.status === 'axis' || t.status === 'resolving')
    .sort(byCreatedAsc);
}

// The main list: everything except notes, oldest first.
export function inboxItems(state) {
  return items(state)
    .filter((t) => !isNote(t))
    .sort(byCreatedAsc);
}

// The Notes screen: notes only, most recently edited first.
export function notes(state) {
  return items(state).filter(isNote).sort(newestEditFirst);
}

// Every word of the query must appear somewhere in a note's title, body or link
// title (case-insensitive, any order). An empty query is the whole list.
export function searchNotes(state, query) {
  const tokens = (typeof query === 'string' ? query : '')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  const all = notes(state);
  if (tokens.length === 0) return all;

  return all.filter((note) => {
    // `?? ''` matters: without it a note lacking a body would match "undefined".
    const haystack = `${note.text ?? ''} ${note.body ?? ''} ${note.linkTitle ?? ''}`.toLowerCase();
    return tokens.every((token) => haystack.includes(token));
  });
}

export function noteCount(state) {
  return items(state).filter(isNote).length;
}
