import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createLinks } = require('../../main/links.js');

const encoder = new TextEncoder();

// A body that yields the chunks one per read, and records how many were read
// and whether the reader gave up on it (which is what closes a real connection).
// highWaterMark 0: nothing is pulled ahead of a read, so `pulled` is exact.
function bodyOf(chunks) {
  const log = { pulled: 0, cancelled: false };
  let next = 0;
  const stream = new ReadableStream({
    pull(controller) {
      if (next >= chunks.length) {
        controller.close();
        return;
      }
      const chunk = chunks[next++];
      log.pulled = next;
      controller.enqueue(typeof chunk === 'string' ? encoder.encode(chunk) : chunk);
    },
    cancel() {
      log.cancelled = true;
    },
  }, { highWaterMark: 0 });
  return { stream, log };
}

// A standard Response around such a body. type: null sends no content-type at all.
function page(chunks, { status = 200, type = 'text/html; charset=utf-8' } = {}) {
  const { stream, log } = bodyOf(Array.isArray(chunks) ? chunks : [chunks]);
  const headers = type === null ? {} : { 'content-type': type };
  return { response: new Response(stream, { status, headers }), log };
}

// A fetch that records its calls and answers with `response` (or the result of calling it).
function fetchReturning(response) {
  const calls = [];
  const fn = async (url, options) => {
    calls.push({ url, options });
    return typeof response === 'function' ? response() : response;
  };
  fn.calls = calls;
  return fn;
}

function fakeShell(behaviour = () => Promise.resolve()) {
  const opened = [];
  return {
    opened,
    openExternal(url) {
      opened.push(url);
      return behaviour(url);
    },
  };
}

const linksWith = (fetch, options = {}) => createLinks({ shell: fakeShell(), fetch, ...options });

describe('openExternal', () => {
  test('hands an http(s) URL to the shell, in its normalised form, and says so', () => {
    const shell = fakeShell();
    const links = createLinks({ shell, fetch: fetchReturning(null) });
    assert.equal(links.openExternal('https://example.com/a b'), true);
    assert.equal(links.openExternal('  http://example.com  '), true);
    assert.deepEqual(shell.opened, ['https://example.com/a%20b', 'http://example.com/']);
  });

  test('refuses everything else, and the shell is never called', () => {
    const shell = fakeShell();
    const links = createLinks({ shell, fetch: fetchReturning(null) });
    const refused = ['javascript:alert(1)', 'java\nscript:alert(1)', 'file:///etc/passwd', 'data:text/html,hi',
      'mailto:a@example.com', 'slack://open', 'example.com', '', '   ', null, undefined, 42, {}, ['https://example.com']];
    for (const input of refused) assert.equal(links.openExternal(input), false, JSON.stringify(input));
    assert.deepEqual(shell.opened, []);
  });

  test('an OS refusal (rejected promise) does not escape as an unhandled rejection', async () => {
    const unhandled = [];
    const listener = (reason) => unhandled.push(reason);
    process.on('unhandledRejection', listener);
    try {
      const links = createLinks({
        shell: fakeShell(() => Promise.reject(new Error('no browser'))),
        fetch: fetchReturning(null),
      });
      assert.equal(links.openExternal('https://example.com'), true);
      await new Promise((resolve) => setImmediate(resolve));  // let any stray rejection surface
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(unhandled, []);
    } finally {
      process.off('unhandledRejection', listener);
    }
  });

  test('a shell that throws synchronously gives false instead of throwing', () => {
    const links = createLinks({
      shell: fakeShell(() => { throw new Error('boom'); }),
      fetch: fetchReturning(null),
    });
    assert.equal(links.openExternal('https://example.com'), false);
  });

  test('a shell that returns nothing at all is fine', () => {
    const links = createLinks({ shell: fakeShell(() => undefined), fetch: fetchReturning(null) });
    assert.equal(links.openExternal('https://example.com'), true);
  });
});

describe('fetchTitle: the request', () => {
  test('asks for the normalised URL with the agreed options', async () => {
    const { response } = page('<title>Hello</title>');
    const fetch = fetchReturning(response);
    const title = await linksWith(fetch).fetchTitle('  HTTPS://Example.com/a b  ');

    assert.equal(title, 'Hello');
    assert.equal(fetch.calls.length, 1);
    const { url, options } = fetch.calls[0];
    assert.equal(url, 'https://example.com/a%20b');
    assert.equal(options.redirect, 'follow');
    assert.deepEqual(options.headers, { 'user-agent': 'Mozilla/5.0 (Macintosh) Blob/1', accept: 'text/html' });
    assert.ok(options.signal instanceof AbortSignal);
    assert.deepEqual(Object.keys(options).sort(), ['headers', 'redirect', 'signal']);
  });

  test('a URL that safeUrl refuses is null, always a promise, and fetch is never called', async () => {
    const fetch = fetchReturning(page('<title>x</title>').response);
    const links = linksWith(fetch);
    for (const input of ['javascript:alert(1)', 'file:///etc/passwd', 'ftp://example.com', 'nope', '', null, undefined, 7, {}]) {
      const result = links.fetchTitle(input);
      assert.ok(result instanceof Promise, JSON.stringify(input));
      assert.equal(await result, null, JSON.stringify(input));
    }
    assert.equal(fetch.calls.length, 0);
  });
});

describe('fetchTitle: the response', () => {
  test('reads a title with the same priority as titleFromHtml', async () => {
    const html = '<html><head><title>Plain</title><meta property="og:title" content="Shared &amp; nice"></head></html>';
    assert.equal(await linksWith(fetchReturning(page(html).response)).fetchTitle('https://example.com'), 'Shared & nice');
  });

  test('a page with no title is null', async () => {
    const { response } = page('<html><head></head><body>hi</body></html>');
    assert.equal(await linksWith(fetchReturning(response)).fetchTitle('https://example.com'), null);
  });

  test('a status that is not ok is null, and the body is let go', async () => {
    for (const status of [301, 403, 404, 500, 503]) {
      const { response, log } = page('<title>Error page</title>', { status });
      assert.equal(await linksWith(fetchReturning(response)).fetchTitle('https://example.com'), null, `status ${status}`);
      assert.equal(log.cancelled, true, `status ${status}: body released`);
    }
  });

  test('a content-type that is not html is null, and the body is let go', async () => {
    for (const type of ['application/json', 'image/png', 'text/plain', 'application/pdf', 'video/mp4', null]) {
      const { response, log } = page('<title>Not really html</title>', { type });
      assert.equal(await linksWith(fetchReturning(response)).fetchTitle('https://example.com'), null, String(type));
      assert.equal(log.cancelled, true, `${type}: body released`);
    }
  });

  test('any html content-type is accepted, whatever the case or parameters', async () => {
    for (const type of ['text/html', 'TEXT/HTML; charset=UTF-8', 'application/xhtml+xml']) {
      const { response } = page('<title>Ok</title>', { type });
      assert.equal(await linksWith(fetchReturning(response)).fetchTitle('https://example.com'), 'Ok', type);
    }
  });

  test('a body of invalid UTF-8 is decoded without throwing', async () => {
    const bytes = Uint8Array.from([...encoder.encode('<title>caf'), 0xe9, ...encoder.encode('!</title>')]);
    const { response } = page([bytes]);
    assert.equal(await linksWith(fetchReturning(response)).fetchTitle('https://example.com'), 'caf�!');
  });
});

describe('fetchTitle: never rejects', () => {
  test('a network error is null', async () => {
    const fetch = async () => { throw new TypeError('fetch failed'); };
    assert.equal(await linksWith(fetch).fetchTitle('https://example.com'), null);
  });

  test('a fetch that throws before returning a promise is null', async () => {
    const fetch = () => { throw new Error('sync boom'); };
    assert.equal(await linksWith(fetch).fetchTitle('https://example.com'), null);
  });

  test('a missing or broken fetch is null', async () => {
    assert.equal(await linksWith(undefined).fetchTitle('https://example.com'), null);
    assert.equal(await linksWith(async () => ({})).fetchTitle('https://example.com'), null);
    assert.equal(await linksWith(async () => null).fetchTitle('https://example.com'), null);
  });

  test('a body that fails halfway is null', async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('<html><head><title>Half'));
        controller.error(new Error('connection reset'));
      },
    });
    const response = new Response(stream, { headers: { 'content-type': 'text/html' } });
    assert.equal(await linksWith(fetchReturning(response)).fetchTitle('https://example.com'), null);
  });

  test('a response with no body at all is null', async () => {
    const response = { ok: true, headers: new Headers({ 'content-type': 'text/html' }), body: null };
    assert.equal(await linksWith(fetchReturning(response)).fetchTitle('https://example.com'), null);
  });
});

describe('fetchTitle: how much it reads', () => {
  test('stops as soon as </head> has gone by, and lets the body go', async () => {
    const head = '<html><head><title>Early</title></head>';
    const chunks = [head, ...Array.from({ length: 200 }, () => 'x'.repeat(1024))];
    const { response, log } = page(chunks);
    assert.equal(await linksWith(fetchReturning(response)).fetchTitle('https://example.com'), 'Early');
    assert.equal(log.cancelled, true);
    assert.equal(log.pulled, 1, `read ${log.pulled} of ${chunks.length} chunks`);
  });

  test('sees </head> even when it is split across chunks, in any case', async () => {
    const chunks = ['<head><title>Split</title></HE', 'AD><body>', ...Array.from({ length: 200 }, () => 'x'.repeat(1024))];
    const { response, log } = page(chunks);
    assert.equal(await linksWith(fetchReturning(response)).fetchTitle('https://example.com'), 'Split');
    assert.equal(log.cancelled, true);
    assert.equal(log.pulled, 2, `read ${log.pulled} of ${chunks.length} chunks`);
  });

  test('gives up at maxBytes: a title beyond the cap is null, and the rest is never downloaded', async () => {
    const chunks = ['<html><head>', ...Array.from({ length: 100 }, () => `<!--${'x'.repeat(1000)}-->`), '<title>Too late</title>'];
    const { response, log } = page(chunks);
    const title = await linksWith(fetchReturning(response), { maxBytes: 2500 }).fetchTitle('https://example.com');
    assert.equal(title, null);
    assert.equal(log.cancelled, true);
    // 12 + 1007 + 1007 bytes, then a 474-byte slice of the fourth chunk reaches the cap.
    assert.equal(log.pulled, 4, `read ${log.pulled} of ${chunks.length} chunks`);
  });

  test('cuts the chunk that crosses the cap: a title inside the cap is found, one that straddles it is not', async () => {
    const doc = '<title>Inside</title>' + 'y'.repeat(5000);
    assert.equal(await linksWith(fetchReturning(page(doc).response), { maxBytes: 21 }).fetchTitle('https://example.com'), 'Inside');
    assert.equal(await linksWith(fetchReturning(page(doc).response), { maxBytes: 20 }).fetchTitle('https://example.com'), null);
  });

  test('maxBytes 0 reads nothing', async () => {
    const { response, log } = page('<title>x</title>');
    assert.equal(await linksWith(fetchReturning(response), { maxBytes: 0 }).fetchTitle('https://example.com'), null);
    assert.equal(log.cancelled, true);
  });

  test('the default cap is 256 KB', async () => {
    const filler = (n) => `<!--${'z'.repeat(n)}-->`;
    const inside = `<title>Found</title>${filler(1000)}`;
    // 200,000 bytes of comment first, then the title: inside the default cap.
    const doc1 = `${filler(200000)}${inside}`;
    assert.equal(await linksWith(fetchReturning(page([doc1]).response)).fetchTitle('https://example.com'), 'Found');
    // 270,000 bytes first: past 262,144.
    const doc2 = `${filler(270000)}${inside}`;
    assert.equal(await linksWith(fetchReturning(page([doc2]).response)).fetchTitle('https://example.com'), null);
  });

  test('a multi-byte character split across chunks decodes correctly', async () => {
    const bytes = encoder.encode('<title>Price: €5 ✓</title>');
    const euro = bytes.indexOf(0xe2);
    const { response } = page([bytes.subarray(0, euro + 1), bytes.subarray(euro + 1, euro + 2), bytes.subarray(euro + 2)]);
    assert.equal(await linksWith(fetchReturning(response)).fetchTitle('https://example.com'), 'Price: €5 ✓');
  });

  test('a title split across many tiny chunks', async () => {
    const chunks = [...'<html><head><title>Byte by byte</title></head>'];
    assert.equal(await linksWith(fetchReturning(page(chunks).response)).fetchTitle('https://example.com'), 'Byte by byte');
  });
});

describe('fetchTitle: the deadline', () => {
  test('a fetch that outlasts timeoutMs is aborted and gives null', { timeout: 5000 }, async () => {
    let seen;
    const slow = (url, { signal }) => new Promise((_, reject) => {
      seen = signal;
      // Never answers by itself: only the abort ends it, so nothing here depends on timing.
      signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    });
    assert.equal(await linksWith(slow, { timeoutMs: 20 }).fetchTitle('https://example.com'), null);
    assert.equal(seen.aborted, true);
  });

  test('the deadline holds even for a fetch that ignores its signal', { timeout: 5000 }, async () => {
    const deaf = () => new Promise(() => {});
    assert.equal(await linksWith(deaf, { timeoutMs: 20 }).fetchTitle('https://example.com'), null);
  });

  test('the deadline covers the body: headers arrive, then the body stalls', { timeout: 5000 }, async () => {
    const stream = new ReadableStream({ pull: () => new Promise(() => {}) }, { highWaterMark: 0 });  // never delivers
    const response = new Response(stream, { headers: { 'content-type': 'text/html' } });
    assert.equal(await linksWith(fetchReturning(response), { timeoutMs: 20 }).fetchTitle('https://example.com'), null);
  });

  test('a late answer after the deadline changes nothing and raises nothing', { timeout: 5000 }, async () => {
    const unhandled = [];
    const listener = (reason) => unhandled.push(reason);
    process.on('unhandledRejection', listener);
    try {
      let answer;
      const late = () => new Promise((resolve, reject) => { answer = { resolve, reject }; });
      const links = linksWith(late, { timeoutMs: 10 });
      assert.equal(await links.fetchTitle('https://example.com'), null);
      answer.reject(new Error('too late'));
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(unhandled, []);
    } finally {
      process.off('unhandledRejection', listener);
    }
  });

  test('a fast answer clears its timer, so nothing is left to keep the app or a test process alive', { timeout: 5000 }, async () => {
    const timers = () => process.getActiveResourcesInfo().filter((name) => name === 'Timeout').length;
    const before = timers();
    const { response } = page('<title>Quick</title>');
    assert.equal(await linksWith(fetchReturning(response), { timeoutMs: 60000 }).fetchTitle('https://example.com'), 'Quick');
    assert.ok(timers() <= before, 'a Timeout was left behind');

    const failing = async () => { throw new Error('down'); };
    assert.equal(await linksWith(failing, { timeoutMs: 60000 }).fetchTitle('https://example.com'), null);
    assert.ok(timers() <= before, 'a Timeout was left behind after a failure');
  });
});
