// Read-side views of the state: pure functions that never mutate what they are
// given (each returns a fresh array, sorted stably) and that treat a state
// without a usable `threads` list as empty rather than crashing a render.
import { linkify } from './linkify.js';
import { isNote, newestEditFirst } from './naturalOrder.js';

const isItem = (t) => t !== null && typeof t === 'object' && !Array.isArray(t);

// filter() also gives every caller its own array, so sorting it in place below
// can never reorder state.threads.
const items = (state) => (Array.isArray(state?.threads) ? state.threads.filter(isItem) : []);

// A missing or garbage timestamp sorts as oldest. Left as NaN it would make
// the comparator inconsistent, and the resulting order engine-defined.
const time = (n) => (Number.isFinite(n) ? n : 0);
const byCreatedAsc = (a, b) => time(a.createdAt) - time(b.createdAt);

// Manual order, once a note has one: lower sorts first. A note without one (there should never be one,
// once migrate() has run — see naturalOrder.js) sorts after every note that does, and ties among those
// fall back to today's rule so nothing is ever engine-defined.
const orderOf = (t) => (Number.isFinite(t.order) ? t.order : null);
function byManualOrder(a, b) {
  const oa = orderOf(a);
  const ob = orderOf(b);
  if (oa !== null && ob !== null) return oa - ob;
  if (oa !== null) return -1;
  if (ob !== null) return 1;
  return newestEditFirst(a, b);
}

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

// How long a crossed-off item stays in the main list before dropping out of it. It is never deleted —
// history (and so doneView.js, the ⚙ screen) keeps it forever regardless — this is only about not
// letting the working list fill up with things that are already finished.
export const DONE_VISIBLE_MS = 30 * 1000;

// inboxItems, minus a done item once DONE_VISIBLE_MS has passed since it was crossed off. `now` is a
// parameter (as elsewhere — see ui/format.js's fmtAgo) so this is testable without a clock: recomputed
// from `doneAt` on every call rather than driven by a one-shot timer, so it is still correct after the
// app was quit and relaunched with the window already (partly) elapsed, which a timer would forget.
// A done item with no usable `doneAt` (should never happen through the app itself — every guarded
// transition that sets status:'done' sets it in the same breath — but a hand-edited or damaged file
// could) stays visible rather than vanishing forever: the failure mode for "can't tell how old this
// is" must be the same as "not old", not an item that's still on disk but unreachable from any screen.
export function visibleInbox(state, now = Date.now()) {
  return inboxItems(state).filter((t) =>
    t.status !== 'done' || !Number.isFinite(t.doneAt) || now - t.doneAt < DONE_VISIBLE_MS);
}

// The Notes screen: notes only, in the order the owner put them in (drag-and-drop). Before a file has ever
// been through migrate() with the reorder feature present, or for a note that somehow still lacks an
// `order`, falls back to newest-edited-first — see byManualOrder.
export function notes(state) {
  return items(state).filter(isNote).sort(byManualOrder);
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
