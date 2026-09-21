import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { safeUrl } = require('../../main/lib/safeUrl.js');

test('accepts http and https and returns the parsed URL', () => {
  const secure = safeUrl('https://example.com/a?b=1#c');
  assert.ok(secure instanceof URL);
  assert.equal(secure.protocol, 'https:');
  assert.equal(secure.href, 'https://example.com/a?b=1#c');

  const plain = safeUrl('http://example.com');
  assert.equal(plain.protocol, 'http:');
  assert.equal(plain.href, 'http://example.com/');
});

test('trims surrounding whitespace, tabs and newlines', () => {
  assert.equal(safeUrl('  https://example.com/x \n').href, 'https://example.com/x');
  assert.equal(safeUrl('\thttp://example.com\t').href, 'http://example.com/');
});

test('the URL is normalised, so callers can use .href instead of the raw text', () => {
  assert.equal(safeUrl('HTTPS://EXAMPLE.COM/a b').href, 'https://example.com/a%20b');
});

test('refuses every other scheme', () => {
  const refused = [
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    '  javascript:alert(1)',
    'java\nscript:alert(1)',   // the URL parser drops the newline: still javascript:
    'java\tscript:alert(1)',
    'file:///etc/passwd',
    'data:text/html,<script>alert(1)</script>',
    'mailto:someone@example.com',
    'tel:+15551234567',
    'ftp://example.com/file',
    'ws://example.com/socket',
    'blob:https://example.com/2a1b3c',
    'about:blank',
    'chrome://settings',
    'vbscript:msgbox(1)',
    'slack://open',
    'x-apple.systempreferences:com.apple.preference.security',
  ];
  for (const input of refused) assert.equal(safeUrl(input), null, `should refuse ${JSON.stringify(input)}`);
});

test('refuses text that is not an absolute URL', () => {
  const refused = ['example.com', 'www.example.com/path', '//example.com', '/just/a/path', 'http://', 'https:',
    'http://exa mple.com', 'not a url', 'https//example.com'];
  for (const input of refused) assert.equal(safeUrl(input), null, `should refuse ${JSON.stringify(input)}`);
});

test('refuses empty and whitespace-only strings', () => {
  assert.equal(safeUrl(''), null);
  assert.equal(safeUrl('   \n\t '), null);
});

test('refuses anything that is not a string', () => {
  const refused = [undefined, null, 0, 42, true, {}, [], ['https://example.com'], () => {}, Symbol('x'), 10n,
    new URL('https://example.com'), new String('https://example.com')];
  for (const input of refused) assert.equal(safeUrl(input), null, `should refuse ${String(typeof input)}`);
});

test('length limit is 2048 characters, counted on the trimmed text', () => {
  const base = 'https://example.com/';
  const exactly = base + 'a'.repeat(2048 - base.length);
  assert.equal(exactly.length, 2048);
  assert.ok(safeUrl(exactly));
  assert.ok(safeUrl(`   ${exactly}   `), 'padding does not count against the limit');
  assert.equal(safeUrl(`${exactly}a`), null);
});
