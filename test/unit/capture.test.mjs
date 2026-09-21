import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseCapture, isBareUrl } from '../../src/core/capture.js';

// Invisible and look-alike characters, built from code points so they stay visible in review.
const NBSP = String.fromCharCode(0xa0);

const parsed = (text, body) => ({ text, body });

describe('parseCapture', () => {
  it('a single line is all title', () => {
    assert.deepEqual(parseCapture('buy milk'), parsed('buy milk', ''));
  });

  it('the first line is the title and the rest is the body', () => {
    assert.deepEqual(parseCapture('title\nbody'), parsed('title', 'body'));
    assert.deepEqual(parseCapture('title\nline 2\nline 3'), parsed('title', 'line 2\nline 3'));
  });

  it('ignores leading blank lines, including whitespace-only ones', () => {
    assert.deepEqual(parseCapture('\n\ntitle\nbody'), parsed('title', 'body'));
    assert.deepEqual(parseCapture('  \n\t\n' + NBSP + '\ntitle\nbody'), parsed('title', 'body'));
  });

  it('trims the title', () => {
    assert.deepEqual(parseCapture('   spaced out \t\nbody'), parsed('spaced out', 'body'));
  });

  it('trims the body at both ends, but keeps blank lines inside it', () => {
    assert.deepEqual(parseCapture('title\n\n\n  body  \n\n\n'), parsed('title', 'body'));
    assert.deepEqual(parseCapture('title\nfirst\n\nsecond\n\n\nthird'), parsed('title', 'first\n\nsecond\n\n\nthird'));
  });

  it('keeps the indentation of later body lines', () => {
    assert.deepEqual(parseCapture('title\nfirst\n  indented\n\ttabbed'), parsed('title', 'first\n  indented\n\ttabbed'));
  });

  it('a title with nothing after it has an empty body', () => {
    assert.deepEqual(parseCapture('title\n'), parsed('title', ''));
    assert.deepEqual(parseCapture('title\n   \n\t\n'), parsed('title', ''));
  });

  it('understands \\r\\n and \\r line endings, and leaves no \\r behind', () => {
    for (const raw of ['a\r\nb\r\nc', 'a\rb\rc', 'a\nb\nc', 'a\r\nb\rc']) {
      assert.deepEqual(parseCapture(raw), parsed('a', 'b\nc'), JSON.stringify(raw));
    }
    assert.deepEqual(parseCapture('a\r\n\r\nb'), parsed('a', 'b'));
    assert.deepEqual(parseCapture('\r\n\r\ntitle\r\nbody\r\n'), parsed('title', 'body'));
  });

  it('blank input gives an empty capture', () => {
    for (const raw of ['', ' ', '\n', '\r\n', '\r', '\t \n \r\n' + NBSP]) {
      assert.deepEqual(parseCapture(raw), parsed('', ''), JSON.stringify(raw));
    }
  });

  it('non-string input gives an empty capture, never a throw', () => {
    for (const raw of [undefined, null, 0, 42, NaN, true, {}, [], ['a\nb'], () => 'a', Symbol('s'), 10n]) {
      assert.deepEqual(parseCapture(raw), parsed('', ''), String(typeof raw));
    }
  });

  it('never splits a single long line', () => {
    const long = 'x'.repeat(10000);
    assert.deepEqual(parseCapture(long), parsed(long, ''));

    const words = Array.from({ length: 2000 }, (_, i) => `word${i}`).join(' ');
    assert.deepEqual(parseCapture(`  ${words}  `), parsed(words, ''));
  });

  it('does not split on anything but line breaks', () => {
    assert.deepEqual(parseCapture('a. b; c, d: e | f - g'), parsed('a. b; c, d: e | f - g', ''));
  });

  it('keeps unicode intact', () => {
    assert.deepEqual(parseCapture('नमस्ते दुनिया\n🔥 emoji body'), parsed('नमस्ते दुनिया', '🔥 emoji body'));
    assert.deepEqual(parseCapture(NBSP + '\nreal title'), parsed('real title', ''));
  });

  it('the title is never empty and never has a line break, for any non-blank input', () => {
    for (const raw of ['a', '\na\n', ' \r\n a \r\n b', 'x\r\n\r\n\r\ny']) {
      const { text } = parseCapture(raw);
      assert.ok(text.length > 0, JSON.stringify(raw));
      assert.ok(!/[\r\n]/.test(text), JSON.stringify(raw));
    }
  });

  it('a pasted link with notes under it keeps the link as the title', () => {
    assert.deepEqual(parseCapture('https://x.org/a\n\nread this later'), parsed('https://x.org/a', 'read this later'));
  });
});

describe('isBareUrl', () => {
  it('is true for one http(s) or www URL', () => {
    for (const text of [
      'https://x.org',
      'http://x.org',
      'www.x.org',
      'https://x.org/path?q=1&r=2#frag',
      'https://www.instagram.com/reels/DdVsAbC123/?igsh=MWx',
      'http://localhost:3000/',
      'https://en.wikipedia.org/wiki/Foo_(bar)',
      'HTTPS://X.ORG',
      'WWW.X.ORG',
    ]) {
      assert.equal(isBareUrl(text), true, text);
    }
  });

  it('ignores whitespace around the URL', () => {
    assert.equal(isBareUrl('  https://x.org  '), true);
    assert.equal(isBareUrl('\n\thttps://x.org\r\n'), true);
  });

  it('is false when anything else is around the URL', () => {
    for (const text of [
      'see https://x.org',
      'https://x.org is great',
      'see https://x.org now',
      'https://x.org https://y.org',
      'https://x.org\nhttps://y.org',
      'https://x.org\nnotes',
      '(https://x.org)',
      '<https://x.org>',
      '"https://x.org"',
      'https://x.org.',
      'https://x.org,',
      'https://x.org/a)',
      'https://x.org/a b',
    ]) {
      assert.equal(isBareUrl(text), false, JSON.stringify(text));
    }
  });

  it('is false for anything that is not an http(s) or www URL', () => {
    for (const text of [
      'x.org',
      'example.com/path',
      'user@example.com',
      'javascript:alert(1)',
      'file:///etc/passwd',
      'data:text/html,hi',
      'mailto:a@b.co',
      'ftp://x.org',
      'tel:+911234567890',
      '//x.org',
      'https://',
      'http://.',
      'www.',
      'www',
      'buy milk',
    ]) {
      assert.equal(isBareUrl(text), false, text);
    }
  });

  it('is false for empty, blank and non-string input', () => {
    for (const text of ['', ' ', '\n', undefined, null, 0, 42, true, {}, [], ['https://x.org'], Symbol('s')]) {
      assert.equal(isBareUrl(text), false, String(typeof text));
    }
  });
});
