// Pure: HTML text -> a short page title, or null.
//
// Order: og:title, then twitter:title, then <title>. The first two are written
// by the site for sharing (no "| SiteName" tacked on); <title> is the fallback.
//
// A small hand-written scanner rather than a few regexes, for two reasons:
//  - it runs on whatever a web server sends, so it has to stay linear in the
//    input: a page of "<meta " with no ">" must not stall the main process;
//  - it has to respect quotes (a ">" inside content="..." does not end the tag)
//    and skip comments and <script>/<style> text, where "<title>" is not markup.

const MAX_LENGTH = 120;

// Named entities we decode. A Map, not an object: "&constructor;" must stay
// text, not find Object.prototype.constructor.
const ENTITIES = new Map([
  ['amp', '&'], ['lt', '<'], ['gt', '>'], ['quot', '"'], ['apos', "'"], ['nbsp', ' '],
]);

// Start of a tag: "<" plus a name. "</p>", "<!doctype>", "<?xml" and "a < b" don't match.
const TAG_START = /<([a-zA-Z][^\s/>]*)/y;

// One step inside a start tag, after any separators. Groups: 1 the closing ">";
// 2 an attribute name, with an optional value: 3 "double", 4 'single' or 5 bare.
// A stray "=" is skipped. Sticky, so every match starts exactly where the last ended.
const TAG_PART = /[\s/]*(?:(>)|([^\s/>=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]*)))?|=)/y;

// Elements whose content is text, not markup, and where that text ends.
const TEXT_ELEMENTS = new Map([
  ['script', /<\/script[\s/>]/gi],
  ['style', /<\/style[\s/>]/gi],
  ['title', /<\/title[\s/>]/gi],
]);

// Returns { attrs, end } for the start tag whose name ends at `from`, or null
// if the page ends inside the tag. Attribute names are lowercased; when one is
// repeated the first wins, as in browsers.
function readTag(html, from) {
  const attrs = new Map();
  TAG_PART.lastIndex = from;
  for (;;) {
    const part = TAG_PART.exec(html);
    if (!part) return null;
    if (part[1]) return { attrs, end: TAG_PART.lastIndex };
    if (part[2] === undefined) continue;
    const name = part[2].toLowerCase();
    if (!attrs.has(name)) attrs.set(name, part[3] ?? part[4] ?? part[5] ?? '');
  }
}

// Files a <meta> tag's content under og / twitter if its property or name says so.
function collectMeta(attrs, found) {
  const content = attrs.get('content');
  if (content === undefined) return;
  const keys = [attrs.get('property'), attrs.get('name')].map((v) => (v || '').trim().toLowerCase());
  if (keys.includes('og:title')) found.og.push(content);
  if (keys.includes('twitter:title')) found.twitter.push(content);
}

// One pass over the page. Returns the raw (still entity-encoded) candidates of
// each kind, in document order.
function scan(html) {
  const found = { og: [], twitter: [], title: [] };
  let at = 0;
  while (at < html.length) {
    const lt = html.indexOf('<', at);
    if (lt === -1) break;

    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 2);  // from +2, so "<!-->" is an empty comment, as in browsers
      if (end === -1) break;                    // an unclosed comment swallows the rest of the page
      at = end + 3;
      continue;
    }

    TAG_START.lastIndex = lt;
    const start = TAG_START.exec(html);
    if (!start) {
      at = lt + 1;
      continue;
    }

    const name = start[1].toLowerCase();
    const tag = readTag(html, TAG_START.lastIndex);
    if (!tag) break;
    at = tag.end;

    if (name === 'meta') {
      collectMeta(tag.attrs, found);
    } else if (TEXT_ELEMENTS.has(name)) {
      const closer = TEXT_ELEMENTS.get(name);
      closer.lastIndex = at;
      const close = closer.exec(html);
      if (!close) break;                        // never closed: the rest of the page is its text
      if (name === 'title') found.title.push(html.slice(at, close.index));
      at = close.index;
    }
  }
  return found;
}

// Decimal and hex references, plus the few named ones above. Anything else
// (an unknown name, a missing ';') is left exactly as written. One pass, so
// "&amp;lt;" becomes "&lt;", not "<".
function decodeEntities(text) {
  return text.replace(/&(?:#(\d+)|#[xX]([0-9a-fA-F]+)|([a-zA-Z][a-zA-Z0-9]*));/g, (whole, dec, hex, name) => {
    if (name !== undefined) return ENTITIES.get(name) ?? whole;
    const code = dec !== undefined ? Number(dec) : parseInt(hex, 16);
    // What HTML does with a number that is not a real character: U+FFFD.
    const valid = code >= 1 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff);
    return valid ? String.fromCodePoint(code) : '�';
  });
}

// Decode first, then collapse whitespace, so &nbsp; and &#10; fold away too.
const tidy = (raw) => decodeEntities(raw).replace(/\s+/g, ' ').trim();

// Total length, ellipsis included, is MAX_LENGTH (counted in UTF-16 units, like
// .length). A cut never splits a surrogate pair, so with an emoji at the edge
// the result is one unit shorter rather than a broken character.
function truncate(text) {
  if (text.length <= MAX_LENGTH) return text;
  let cut = MAX_LENGTH - 1;
  const last = text.charCodeAt(cut - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut -= 1;
  return `${text.slice(0, cut)}…`;
}

function titleFromHtml(html) {
  if (typeof html !== 'string') return null;
  const found = scan(html);
  // An empty candidate (content="", a whitespace-only <title>) falls through to the next.
  for (const candidates of [found.og, found.twitter, found.title]) {
    for (const raw of candidates) {
      const text = tidy(raw);
      if (text) return truncate(text);
    }
  }
  return null;
}

module.exports = { titleFromHtml };
