// Read-side views of the state: pure functions that never mutate what they are
// given (each returns a fresh array, sorted stably) and that treat a state
// without a usable `threads` list as empty rather than crashing a render.
import { linkify } from './linkify.js';

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

// The address without what a person doesn't need to read: no scheme, no "www.", no trailing slash, no query
// or fragment. instagram.com/reel/DdVsabc instead of https://www.instagram.com/reel/DdVsabc/?igsh=xyz.
function shorten(url) {
  const host = url.hostname.replace(/^www\./i, '');
  let path = url.pathname.replace(/\/+$/, '');
  try { path = decodeURIComponent(path); } catch { /* a malformed escape: show the path as it is */ }
  return `${host}${path}`;
}

// How an item's title should read. A title that is nothing but ONE link shows the title of the page it points
// to (fetched when the item was captured) with the site beside it in the domain; until there is a page title,
// it shows the shortened address. Anything else reads as written.
//   { kind: 'text', label }
//   { kind: 'link', label, href, domain }      domain is '' when there is no page title to add it to
// `label` is what to show wherever there is only room for one string (a row, an axis bar, a tooltip).
export function displayTitle(item) {
  const raw = typeof item?.text === 'string' ? item.text : '';
  const parts = linkify(raw.trim());
  if (parts.length !== 1 || parts[0].type !== 'link') return { kind: 'text', label: raw };

  const { href } = parts[0];
  let url;
  try { url = new URL(href); } catch { return { kind: 'text', label: raw }; }
  const title = typeof item.linkTitle === 'string' ? item.linkTitle.trim() : '';
  return {
    kind: 'link',
    label: title || shorten(url),
    href,
    domain: title ? url.hostname.replace(/^www\./i, '') : '',
  };
}
