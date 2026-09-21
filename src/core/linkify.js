// Finds the links in a piece of text, so a view can build real elements for
// them (a text node here, an <a> there) instead of parsing markup strings.
// Only http://, https:// and www. are ever links. Other schemes (javascript:,
// file:, data:, mailto: ...) and bare domains (example.com) stay plain text on
// purpose: a link the user did not clearly write is a click they did not
// clearly mean.

/** @typedef {{ type: 'text', value: string }} TextSegment */
/** @typedef {{ type: 'link', value: string, href: string }} LinkSegment */
/** @typedef {TextSegment | LinkSegment} Segment */

// A match may not start inside a longer word, host or address: "awww.x.com",
// "me@www.x.com" and "foo.www.x.com" are not links to www.x.com. It runs to
// the next whitespace or angle bracket; trimTrailing() then hands back what the
// sentence around the URL put at its end.
const CANDIDATE = /(?<![\w@.-])(?:https?:\/\/|www\.)[^\s<>]+/gi;

// What macOS and iOS smart punctuation types for a right single quote, a right
// double quote and an ellipsis. new URL() accepts the quotes inside a host, so
// they would silently become part of the link, and rejects the ellipsis, so the
// whole link would vanish. (Built from code points so they stay visible here.)
const SMART_PUNCTUATION = String.fromCharCode(0x2019, 0x201d, 0x2026);

// Punctuation that ends a sentence, not a URL.
const TRAILING_PUNCTUATION = new Set(['.', ',', ';', ':', '!', '?', "'", '"', ...SMART_PUNCTUATION]);

const SAFE_PROTOCOLS = new Set(['http:', 'https:']);

// new URL() quietly drops tabs, newlines and control characters; an href we
// hand out must be exactly the text the user sees.
function hasSpaceOrControl(text) {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code <= 0x20 || code === 0x7f) return true; // space, C0 controls, DEL
  }
  return /\s/.test(text); // Unicode spaces: no-break space, line separator, ...
}

const count = (text, char) => text.split(char).length - 1;

// Drops trailing punctuation, and closing brackets that have no opener inside
// the URL: "Foo_(bar)" keeps its ")" but "(see https://x.org/a)" does not.
function trimTrailing(value) {
  // Closers minus openers in the text kept so far. Tracked as a running total
  // (not recounted per character) so a long run of ")))" stays linear.
  const surplus = {
    ')': count(value, ')') - count(value, '('),
    ']': count(value, ']') - count(value, '['),
    '}': count(value, '}') - count(value, '{'),
  };
  let end = value.length;
  for (;;) {
    const last = value[end - 1];
    if (TRAILING_PUNCTUATION.has(last)) {
      end--;
    } else if (surplus[last] > 0) {
      surplus[last]--;
      end--;
    } else {
      return value.slice(0, end);
    }
  }
}

/**
 * The href for a link candidate, or null when it is not a safe web link.
 * Only http(s):// and www. qualify; the href is the candidate itself, with
 * https:// put in front of a www. one.
 * @param {string} candidate
 * @returns {string | null}
 */
export function toHref(candidate) {
  if (typeof candidate !== 'string' || hasSpaceOrControl(candidate)) return null;

  let href;
  if (/^https?:\/\/./i.test(candidate)) href = candidate;
  else if (/^www\..+/i.test(candidate)) href = `https://${candidate}`;
  else return null; // no other scheme, no bare domain

  // Parsing is the real gate: nothing that fails it, or that is not http(s),
  // ever becomes an href.
  try {
    return SAFE_PROTOCOLS.has(new URL(href).protocol) ? href : null;
  } catch {
    return null;
  }
}

/**
 * Splits text into plain and link segments. Joining every segment's `value`
 * gives back exactly the input; adjacent plain text is one segment.
 * @param {string} text
 * @returns {Segment[]}
 */
export function linkify(text) {
  if (typeof text !== 'string' || text === '') return [];

  const segments = [];
  let cursor = 0; // start of the text not yet emitted
  for (const match of text.matchAll(CANDIDATE)) {
    const value = trimTrailing(match[0]);
    const href = toHref(value);
    if (href === null) continue; // not a safe link after all: it stays plain text

    if (match.index > cursor) segments.push({ type: 'text', value: text.slice(cursor, match.index) });
    segments.push({ type: 'link', value, href });
    cursor = match.index + value.length; // the trimmed tail becomes part of the next text
  }
  if (cursor < text.length) segments.push({ type: 'text', value: text.slice(cursor) });
  return segments;
}
