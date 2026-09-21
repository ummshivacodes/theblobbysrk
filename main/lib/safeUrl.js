// Pure: the one place that decides which strings we will open in a browser or
// fetch. Only http(s) passes: everything else (javascript:, file:, data:,
// mailto:, custom app schemes) is refused, because a link in a note is
// untrusted text and shell.openExternal will launch whatever handles the scheme.
//
// Returns the parsed URL so callers use `.href` (the normalised form), never
// the raw input: the parser strips tabs/newlines and percent-encodes spaces,
// which is what makes "java\nscript:..." come out as a refusable javascript:.

const MAX_LENGTH = 2048;
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

function safeUrl(input) {
  if (typeof input !== 'string') return null;
  const text = input.trim();
  if (text === '' || text.length > MAX_LENGTH) return null;

  let url;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  return ALLOWED_PROTOCOLS.has(url.protocol) ? url : null;
}

module.exports = { safeUrl };
