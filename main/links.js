// What the main process does with a link. Both effects come in through the
// factory (shell, fetch), so this file imports nothing from the app shell and
// runs in plain Node under test; main.js hands in the real `shell` and `net.fetch`.
//
// The renderer is not trusted: every URL is re-validated here with safeUrl,
// whatever the caller already checked.

const { safeUrl } = require('./lib/safeUrl');
const { titleFromHtml } = require('./lib/titleFromHtml');

// Plenty of sites serve a bot wall or a bare page to an unknown agent.
const REQUEST_HEADERS = { 'user-agent': 'Mozilla/5.0 (Macintosh) Blob/1', accept: 'text/html' };
const END_OF_HEAD = '</head>';

// An unread body keeps its connection busy; cancelling it frees the connection.
function release(response) {
  if (response.body) response.body.cancel().catch(() => {});
}

// The body as UTF-8 text: at most maxBytes, and only up to </head> (the title
// lives there; the rest of a heavy page isn't worth downloading). Whatever way
// it ends, the stream is cancelled, which is what closes an unfinished download.
async function readHead(response, maxBytes) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();  // UTF-8; a bad byte becomes U+FFFD instead of throwing
  let text = '';
  let bytes = 0;
  let tail = '';                      // end of the previous chunk, so a "</head>" split across two is still seen
  try {
    while (bytes < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value.length > maxBytes - bytes ? value.subarray(0, maxBytes - bytes) : value;
      bytes += chunk.length;
      const piece = decoder.decode(chunk, { stream: true });
      text += piece;
      const window = (tail + piece).toLowerCase();
      if (window.includes(END_OF_HEAD)) break;
      tail = window.slice(-(END_OF_HEAD.length - 1));
    }
    return text + decoder.decode();
  } finally {
    reader.cancel().catch(() => {});
  }
}

function createLinks({ shell, fetch, timeoutMs = 5000, maxBytes = 262144 }) {
  // true = the URL was acceptable and has been handed to the OS. The OS may
  // still refuse; that is not the caller's problem, and must not surface as an
  // unhandled rejection.
  function openExternal(url) {
    const parsed = safeUrl(url);
    if (!parsed) return false;
    try {
      Promise.resolve(shell.openExternal(parsed.href)).catch(() => {});
      return true;
    } catch {
      return false;
    }
  }

  async function download(href, signal) {
    const response = await fetch(href, { signal, redirect: 'follow', headers: { ...REQUEST_HEADERS } });
    const isHtml = /html/i.test(response.headers.get('content-type') || '');
    if (!response.ok || !isHtml) {
      release(response);
      return null;
    }
    return titleFromHtml(await readHead(response, maxBytes));
  }

  // The page's title, or null. Never rejects: a title is a nicety, so any
  // failure (bad URL, network, status, type, timeout, parse) is just "no title".
  async function fetchTitle(url) {
    let timer;
    try {
      const parsed = safeUrl(url);
      if (!parsed) return null;

      // One deadline for the whole exchange, body included. It aborts the fetch
      // and also wins the race on its own, so even a fetch that ignores its
      // signal cannot keep us waiting.
      const controller = new AbortController();
      const deadline = new Promise((resolve) => {
        timer = setTimeout(() => {
          controller.abort();
          resolve(null);
        }, timeoutMs);
      });
      return await Promise.race([download(parsed.href, controller.signal), deadline]);
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  return { openExternal, fetchTitle };
}

module.exports = { createLinks };
