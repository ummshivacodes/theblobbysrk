import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { linkify, toHref } from '../../src/core/linkify.js';

// Invisible and look-alike characters, built from code points so they stay visible in review.
const NBSP = String.fromCharCode(0xa0);
const NUL = String.fromCharCode(0x0);
const SOH = String.fromCharCode(0x1);
const DEL = String.fromCharCode(0x7f);
const LINE_SEPARATOR = String.fromCharCode(0x2028);
const ZERO_WIDTH_SPACE = String.fromCharCode(0x200b);
const LEFT_DQUOTE = String.fromCharCode(0x201c);
const RIGHT_DQUOTE = String.fromCharCode(0x201d);
const LEFT_SQUOTE = String.fromCharCode(0x2018);
const RIGHT_SQUOTE = String.fromCharCode(0x2019);
const ELLIPSIS = String.fromCharCode(0x2026);

const text = (value) => ({ type: 'text', value });
const link = (value, href = value) => ({ type: 'link', value, href });
const joined = (segments) => segments.map((s) => s.value).join('');

describe('toHref', () => {
  it('accepts http(s) URLs and returns them as written', () => {
    for (const candidate of [
      'https://x.org',
      'http://x.org',
      'HTTPS://X.COM',
      'HtTp://x.org/Path',
      'https://x.org:8080/a/b?c=d&e=f#g',
      'http://user:pass@x.org/',
      'http://localhost:3000',
      'http://192.168.0.1/admin',
      'http://[::1]:8080/',
      'https://en.wikipedia.org/wiki/Foo_(bar)',
      'https://x.org/日本語',
    ]) {
      assert.equal(toHref(candidate), candidate);
    }
  });

  it('puts https:// in front of a www. URL', () => {
    assert.equal(toHref('www.x.org'), 'https://www.x.org');
    assert.equal(toHref('WWW.X.ORG'), 'https://WWW.X.ORG');
    assert.equal(toHref('Www.x.org/a?b=1#c'), 'https://Www.x.org/a?b=1#c');
  });

  it('rejects other schemes, bare domains and lookalikes', () => {
    for (const candidate of [
      'javascript:alert(1)',
      'JAVASCRIPT:alert(1)',
      'javascript:www.x.org',
      'javascript://x.org/%0Aalert(1)',
      'file:///etc/passwd',
      'data:text/html,hi',
      'mailto:a@b.co',
      'ftp://x.org',
      'ws://x.org',
      'wss://x.org',
      'blob:https://x.org/1',
      'tel:123',
      'chrome://settings',
      'about:blank',
      '',
      'x.org',
      'example.com',
      'sub.example.co.uk/path',
      'user@example.com',
      'localhost:3000',
      '//x.org',
      'https:/x.org',
      'https:x.org',
      'http//x.org',
      'htp://x.org',
      'wwww.x.org',
      'xwww.x.org',
      'www.',
      'www',
    ]) {
      assert.equal(toHref(candidate), null, candidate);
    }
  });

  it('rejects what new URL() cannot parse', () => {
    for (const candidate of ['https://', 'http://', 'https:///', 'http://[::1', 'https://[nope]/']) {
      assert.equal(toHref(candidate), null, candidate);
    }
  });

  it('rejects anything with whitespace or control characters, which new URL() would quietly repair', () => {
    for (const candidate of [
      ' https://x.org',
      'https://x.org ',
      'https://x.org/a b',
      'https://x.org/a\nb',
      'https://x.org/a\tb',
      'https://x.org/' + NBSP,
      'https://x.org' + NUL,
      'https://x.org/' + SOH,
      'https://x.org/' + DEL,
      'https://exa mple.com',
    ]) {
      assert.equal(toHref(candidate), null, JSON.stringify(candidate));
    }
  });

  it('rejects non-strings without throwing', () => {
    for (const candidate of [undefined, null, 0, 42, true, {}, [], ['https://x.org'], () => 'https://x.org', Symbol('s'), 10n]) {
      assert.equal(toHref(candidate), null, String(typeof candidate));
    }
  });

  it('every href it returns parses with new URL() and is http or https', () => {
    for (const candidate of ['https://x.org', 'HTTP://X.ORG', 'www.x.org', 'https://x.org/a?b#c', 'http://[::1]/']) {
      const href = toHref(candidate);
      assert.notEqual(href, null, candidate);
      assert.ok(['http:', 'https:'].includes(new URL(href).protocol), href);
    }
  });
});

describe('linkify: the basics', () => {
  it('empty text has no segments', () => {
    assert.deepEqual(linkify(''), []);
  });

  it('text without links is one text segment', () => {
    assert.deepEqual(linkify('just a note'), [text('just a note')]);
    assert.deepEqual(linkify('a. b, c; d'), [text('a. b, c; d')]);
  });

  it('a bare URL is one link segment', () => {
    assert.deepEqual(linkify('https://x.org'), [link('https://x.org')]);
    assert.deepEqual(linkify('http://x.org/a?b=1#c'), [link('http://x.org/a?b=1#c')]);
  });

  it('a www. URL links to its https:// form, and keeps its own text as the value', () => {
    assert.deepEqual(linkify('www.x.org'), [link('www.x.org', 'https://www.x.org')]);
  });

  it('non-string input has no segments', () => {
    for (const input of [undefined, null, 0, 42, true, {}, [], ['https://x.org']]) {
      assert.deepEqual(linkify(input), [], String(typeof input));
    }
  });
});

describe('linkify: where the URL sits', () => {
  it('in the middle of text', () => {
    assert.deepEqual(linkify('see https://x.org now'), [text('see '), link('https://x.org'), text(' now')]);
  });

  it('at the very start', () => {
    assert.deepEqual(linkify('https://x.org is up'), [link('https://x.org'), text(' is up')]);
  });

  it('at the very end', () => {
    assert.deepEqual(linkify('go to https://x.org'), [text('go to '), link('https://x.org')]);
  });

  it('followed by a newline', () => {
    assert.deepEqual(linkify('https://x.org\nnext line'), [link('https://x.org'), text('\nnext line')]);
    assert.deepEqual(linkify('a\r\nhttps://x.org\r\nb'), [text('a\r\n'), link('https://x.org'), text('\r\nb')]);
    assert.deepEqual(linkify('\n\nhttps://x.org\n\n'), [text('\n\n'), link('https://x.org'), text('\n\n')]);
  });

  it('several URLs in one string', () => {
    assert.deepEqual(linkify('a https://x.org b http://y.org c www.z.org d'), [
      text('a '),
      link('https://x.org'),
      text(' b '),
      link('http://y.org'),
      text(' c '),
      link('www.z.org', 'https://www.z.org'),
      text(' d'),
    ]);
    assert.deepEqual(linkify('https://a.com, https://b.com; www.c.com.'), [
      link('https://a.com'),
      text(', '),
      link('https://b.com'),
      text('; '),
      link('www.c.com', 'https://www.c.com'),
      text('.'),
    ]);
    assert.deepEqual(linkify('https://a.com\nhttps://b.com'), [link('https://a.com'), text('\n'), link('https://b.com')]);
    assert.deepEqual(linkify('https://a.com https://a.com'), [link('https://a.com'), text(' '), link('https://a.com')]);
  });

  it('stops at an angle bracket', () => {
    assert.deepEqual(linkify('<https://x.org>'), [text('<'), link('https://x.org'), text('>')]);
    assert.deepEqual(linkify('https://x.org<b>bold</b>'), [link('https://x.org'), text('<b>bold</b>')]);
  });

  it('a URL with a colon before it is still found', () => {
    assert.deepEqual(linkify('link:https://x.org'), [text('link:'), link('https://x.org')]);
  });
});

describe('linkify: the scheme is case-insensitive', () => {
  it('uppercase and mixed-case schemes and www are links', () => {
    assert.deepEqual(linkify('HTTPS://X.COM'), [link('HTTPS://X.COM')]);
    assert.deepEqual(linkify('HtTp://x.org'), [link('HtTp://x.org')]);
    assert.deepEqual(linkify('Visit WWW.EXAMPLE.COM/Path.'), [
      text('Visit '),
      link('WWW.EXAMPLE.COM/Path', 'https://WWW.EXAMPLE.COM/Path'),
      text('.'),
    ]);
  });
});

describe('linkify: trailing punctuation is never part of the link', () => {
  for (const mark of ['.', ',', ';', ':', '!', '?', "'", '"']) {
    it(`${mark}`, () => {
      assert.deepEqual(linkify(`see https://x.org/a${mark}`), [text('see '), link('https://x.org/a'), text(mark)]);
      assert.deepEqual(linkify(`www.x.org${mark}`), [link('www.x.org', 'https://www.x.org'), text(mark)]);
      assert.deepEqual(linkify(`https://x.org/a${mark}\nnext`), [link('https://x.org/a'), text(`${mark}\nnext`)]);
    });
  }

  it('a run of it, in any mix', () => {
    assert.deepEqual(linkify('https://x.org/a?!.'), [link('https://x.org/a'), text('?!.')]);
    assert.deepEqual(linkify('https://x.org/a...'), [link('https://x.org/a'), text('...')]);
    assert.deepEqual(linkify('https://x.org/a.,;:!?\'"'), [link('https://x.org/a'), text('.,;:!?\'"')]);
  });

  it('smart quotes and the ellipsis that macOS and iOS type are trimmed too', () => {
    assert.deepEqual(linkify(LEFT_DQUOTE + 'https://x.org' + RIGHT_DQUOTE), [text(LEFT_DQUOTE), link('https://x.org'), text(RIGHT_DQUOTE)]);
    assert.deepEqual(linkify(LEFT_SQUOTE + 'https://x.org' + RIGHT_SQUOTE), [text(LEFT_SQUOTE), link('https://x.org'), text(RIGHT_SQUOTE)]);
    assert.deepEqual(linkify('https://x.org' + ELLIPSIS), [link('https://x.org'), text(ELLIPSIS)]);
  });

  it('is only trimmed at the end: the same characters inside a URL stay', () => {
    const inside = 'https://x.org/a.b,c;d:e!f?g=1&h\'i"j';
    assert.deepEqual(linkify(inside), [link(inside)]);
  });

  it('quotes around a URL are not part of it', () => {
    assert.deepEqual(linkify('"https://x.org"'), [text('"'), link('https://x.org'), text('"')]);
    assert.deepEqual(linkify("'https://x.org/a',"), [text("'"), link('https://x.org/a'), text("',")]);
  });
});

describe('linkify: closing brackets', () => {
  const cases = [
    // A closer with an opener inside the URL belongs to it...
    ['https://en.wikipedia.org/wiki/Foo_(bar)', [link('https://en.wikipedia.org/wiki/Foo_(bar)')]],
    ['https://x.org/a[1]', [link('https://x.org/a[1]')]],
    ['https://x.org/{id}', [link('https://x.org/{id}')]],
    ['http://[::1]', [link('http://[::1]')]],
    ['http://[::1]:8080/x', [link('http://[::1]:8080/x')]],
    // ...one without an opener stays outside.
    ['(see https://x.org/a)', [text('(see '), link('https://x.org/a'), text(')')]],
    ['[https://x.org/a]', [text('['), link('https://x.org/a'), text(']')]],
    ['{https://x.org/a}', [text('{'), link('https://x.org/a'), text('}')]],
    ['https://x.org/a)', [link('https://x.org/a'), text(')')]],
    ['https://x.org/a))', [link('https://x.org/a'), text('))')]],
    ['[docs](https://x.org/docs)', [text('[docs]('), link('https://x.org/docs'), text(')')]],
    // Only the surplus goes.
    ['(https://en.wikipedia.org/wiki/Foo_(bar))', [text('('), link('https://en.wikipedia.org/wiki/Foo_(bar)'), text(')')]],
    ['https://x.org/a)b)', [link('https://x.org/a)b'), text(')')]],
    // Brackets of one kind never vouch for another kind.
    ['https://x.org/a(b]', [link('https://x.org/a(b'), text(']')]],
    // Punctuation and brackets peel off together.
    ['https://x.org/Foo_(bar).', [link('https://x.org/Foo_(bar)'), text('.')]],
    ['https://x.org/Foo_(bar)?', [link('https://x.org/Foo_(bar)'), text('?')]],
    ['(https://x.org/a).', [text('('), link('https://x.org/a'), text(').')]],
    ['(https://x.org/a?)', [text('('), link('https://x.org/a'), text('?)')]],
    // An opener with no closer is just part of the URL.
    ['https://x.org/a(b', [link('https://x.org/a(b')]],
  ];
  for (const [input, expected] of cases) {
    it(input, () => {
      assert.deepEqual(linkify(input), expected);
    });
  }
});

describe('linkify: what is never a link', () => {
  it('other schemes stay plain text', () => {
    for (const input of [
      'javascript:alert(1)',
      'JAVASCRIPT:alert(document.cookie)',
      'file:///etc/passwd',
      'data:text/html,<script>alert(1)</script>',
      'mailto:someone@example.com',
      'ftp://example.com/file',
      'tel:+911234567890',
      'ssh://git@github.com/x.git',
      'chrome://settings',
      'about:blank',
      'vbscript:msgbox(1)',
      'ws://example.com',
      'blob:null/abc',
    ]) {
      assert.deepEqual(linkify(input), [text(input)], input);
    }
  });

  it('bare domains, addresses and paths stay plain text', () => {
    for (const input of ['example.com', 'sub.example.co.uk/path?q=1', 'localhost:3000', '192.168.0.1', 'user@example.com', 'x.org/path']) {
      assert.deepEqual(linkify(input), [text(input)], input);
    }
  });

  it('a URL start inside a longer word, host or address is not a link', () => {
    for (const input of [
      'awww.example.com',
      'wwww.example.com',
      'foo.www.example.com',
      'me@www.example.com',
      'my-www.example.com',
      '_www.example.com',
      '9www.example.com',
      'xhttps://example.com',
      'ahttp://example.com',
    ]) {
      assert.deepEqual(linkify(input), [text(input)], input);
    }
  });

  it('an unparseable candidate stays plain text and leaves its neighbours alone', () => {
    for (const input of ['http://.', 'https://?', 'https://,', 'http://[::1', 'www.', 'www', 'http://', 'https://']) {
      assert.deepEqual(linkify(input), [text(input)], input);
    }
    assert.deepEqual(linkify('http://. then https://x.org'), [text('http://. then '), link('https://x.org')]);
    assert.deepEqual(linkify('a http://. b'), [text('a http://. b')]);
  });
});

describe('linkify: text is preserved exactly', () => {
  it('unicode, emoji and mixed scripts', () => {
    assert.deepEqual(linkify('héllo wörld'), [text('héllo wörld')]);
    assert.deepEqual(linkify('日本語 https://x.org/日本語 です'), [text('日本語 '), link('https://x.org/日本語'), text(' です')]);
    assert.deepEqual(linkify('🔥 https://x.org 🔥'), [text('🔥 '), link('https://x.org'), text(' 🔥')]);
    assert.deepEqual(linkify('नमस्ते https://x.org दुनिया'), [text('नमस्ते '), link('https://x.org'), text(' दुनिया')]);
  });

  it('every kind of whitespace ends a URL and is kept', () => {
    assert.deepEqual(linkify('a\t\thttps://x.org' + NBSP + 'b'), [text('a\t\t'), link('https://x.org'), text(NBSP + 'b')]);
    assert.deepEqual(linkify('https://x.org' + LINE_SEPARATOR + 'next'), [link('https://x.org'), text(LINE_SEPARATOR + 'next')]);
    assert.deepEqual(linkify('  https://x.org  '), [text('  '), link('https://x.org'), text('  ')]);
  });

  it('joining the segments gives back the input', () => {
    for (const input of [
      '',
      ' ',
      '\n',
      'plain',
      'https://x.org',
      '(see https://x.org/a), and www.y.org! Also "http://z.org".\nDone' + ELLIPSIS,
      'https://x.org\r\n\r\nhttps://y.org\r\n',
      '\ud83d lone surrogate https://x.org',
    ]) {
      assert.equal(joined(linkify(input)), input, JSON.stringify(input));
    }
  });

  it('merges adjacent plain text into one segment', () => {
    assert.deepEqual(linkify('no links here. really. www. nope'), [text('no links here. really. www. nope')]);
    assert.deepEqual(linkify('a http://. b https://x.org c http://. d'), [
      text('a http://. b '),
      link('https://x.org'),
      text(' c http://. d'),
    ]);
  });
});

describe('linkify: behaves the same on every call', () => {
  it('keeps no state between calls, whatever order they come in', () => {
    const inputs = ['see https://x.org', 'www.y.org, ok', 'nothing', '(https://z.org/a_(b))', ''];
    const first = inputs.map((input) => linkify(input));
    const reversed = [...inputs].reverse().map((input) => linkify(input)).reverse();
    assert.deepEqual(reversed, first);
    assert.deepEqual(inputs.map((input) => linkify(input)), first);
  });

  it('returns fresh segments each time', () => {
    const a = linkify('https://x.org');
    a[0].value = 'changed';
    a.push(text('extra'));
    assert.deepEqual(linkify('https://x.org'), [link('https://x.org')]);
  });

  it('stays correct (and fast enough to finish) on very long runs', () => {
    const parens = `https://x.org/${')'.repeat(200000)}`;
    assert.deepEqual(linkify(parens), [link('https://x.org/'), text(')'.repeat(200000))]);

    const longUrl = `https://x.org/${'a'.repeat(200000)}`;
    assert.deepEqual(linkify(longUrl), [link(longUrl)]);

    const noLinks = 'plain words and www. and http:// '.repeat(20000);
    assert.equal(joined(linkify(noLinks)), noLinks);
  });
});

// The invariant the views rely on, checked against many strings built from the
// pieces that make linkifying hard: schemes, brackets, punctuation, whitespace,
// unicode. Seeded, so any failure reproduces exactly.
describe('linkify: invariants over many generated inputs', () => {
  function mulberry32(seed) {
    let a = seed;
    return () => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const PIECES = [
    'http://', 'https://', 'HTTPS://', 'www.', 'WWW.', 'ftp://', 'mailto:', 'javascript:', 'data:', 'file:///',
    'example.com', 'x.org', 'a', 'Z', '9', '_', '-', '@', '/', '/path', '?q=1', '#h', '%20', '=',
    '(', ')', '[', ']', '{', '}', '.', ',', ';', ':', '!', '?', "'", '"', RIGHT_SQUOTE, RIGHT_DQUOTE, ELLIPSIS, '<', '>',
    ' ', '  ', '\n', '\r\n', '\t', NBSP, LINE_SEPARATOR, ZERO_WIDTH_SPACE,
    'é', '日本語', '🔥', 'नमस्ते', '\ud83d',
  ];
  const TRAILING = new Set(['.', ',', ';', ':', '!', '?', "'", '"', RIGHT_SQUOTE, RIGHT_DQUOTE, ELLIPSIS]);
  const occurrences = (s, ch) => s.split(ch).length - 1;

  it('holds for 5000 generated strings', () => {
    const random = mulberry32(20260921);
    for (let n = 0; n < 5000; n++) {
      const pieces = Array.from({ length: 1 + Math.floor(random() * 14) }, () => PIECES[Math.floor(random() * PIECES.length)]);
      const input = pieces.join('');
      const note = JSON.stringify(input);
      const segments = linkify(input);

      // Nothing lost, nothing added, nothing reordered.
      assert.equal(joined(segments), input, note);
      // Never an empty segment; adjacent text is always merged.
      segments.forEach((segment, i) => {
        assert.ok(segment.value.length > 0, note);
        if (segment.type === 'text') assert.notEqual(segments[i + 1]?.type, 'text', note);
      });

      for (const segment of segments.filter((s) => s.type === 'link')) {
        const { value, href } = segment;
        // Only web links, and only ones the URL parser accepts.
        assert.match(value, /^(https?:\/\/|www\.)/i, note);
        assert.ok(['http:', 'https:'].includes(new URL(href).protocol), note);
        assert.equal(href, toHref(value), note);
        assert.equal(href, /^www\./i.test(value) ? `https://${value}` : value, note);
        // Sentence punctuation and whitespace never end up inside.
        assert.ok(!TRAILING.has(value.at(-1)), note);
        assert.ok(!/[\s<>]/.test(value), note);
        // A closing bracket at the end always has an opener to pair with.
        for (const [closer, opener] of [[')', '('], [']', '['], ['}', '{']]) {
          if (value.endsWith(closer)) assert.ok(occurrences(value, opener) >= occurrences(value, closer), note);
        }
      }
    }
  });
});
