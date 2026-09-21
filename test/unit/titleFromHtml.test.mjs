import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { titleFromHtml } = require('../../main/lib/titleFromHtml.js');

describe('which candidate wins', () => {
  test('og:title beats twitter:title beats <title>', () => {
    const html = '<title>From title</title>'
      + '<meta name="twitter:title" content="From twitter">'
      + '<meta property="og:title" content="From og">';
    assert.equal(titleFromHtml(html), 'From og');
  });

  test('twitter:title beats <title>', () => {
    assert.equal(
      titleFromHtml('<title>From title</title><meta name="twitter:title" content="From twitter">'),
      'From twitter',
    );
  });

  test('falls back to <title>', () => {
    assert.equal(titleFromHtml('<html><head><title>Just a title</title></head></html>'), 'Just a title');
  });

  test('a candidate that is empty after tidying falls through to the next', () => {
    const empties = '<meta property="og:title" content="">'
      + '<meta name="twitter:title" content="  &nbsp; \n ">';
    assert.equal(titleFromHtml(`${empties}<title>Real</title>`), 'Real');
    assert.equal(titleFromHtml('<meta property="og:title" content=" "><meta name="twitter:title" content="Tw">'), 'Tw');
  });

  test('the first non-empty tag of the same kind wins', () => {
    const html = '<meta property="og:title" content=""><meta property="og:title" content="Second">'
      + '<meta property="og:title" content="Third">';
    assert.equal(titleFromHtml(html), 'Second');
    assert.equal(titleFromHtml('<title></title><title>Later</title>'), 'Later');
  });

  test('null when there is nothing usable', () => {
    for (const html of ['', '   ', 'plain text, no markup', '<html><head></head><body>hi</body></html>',
      '<title></title>', '<title>  \n </title>', '<title>&nbsp;</title>']) {
      assert.equal(titleFromHtml(html), null, JSON.stringify(html));
    }
  });
});

describe('meta tags', () => {
  test('attributes may come in either order', () => {
    assert.equal(titleFromHtml('<meta property="og:title" content="A">'), 'A');
    assert.equal(titleFromHtml('<meta content="B" property="og:title">'), 'B');
    assert.equal(titleFromHtml('<meta data-x="1" content="C" charset="utf-8" name="twitter:title" >'), 'C');
  });

  test('double, single or no quotes', () => {
    assert.equal(titleFromHtml('<meta property="og:title" content="double">'), 'double');
    assert.equal(titleFromHtml("<meta property='og:title' content='single'>"), 'single');
    assert.equal(titleFromHtml('<meta property=og:title content=bare>'), 'bare');
    assert.equal(titleFromHtml(`<meta property='og:title' content="it's">`), "it's");
    assert.equal(titleFromHtml(`<meta property="og:title" content='say "hi"'>`), 'say "hi"');
  });

  test('tag names, attribute names and their values are case-insensitive', () => {
    assert.equal(titleFromHtml('<META PROPERTY="OG:TITLE" CONTENT="Shouting">'), 'Shouting');
    assert.equal(titleFromHtml('<Meta Name="Twitter:Title" Content="Mixed">'), 'Mixed');
  });

  test('og:title also via name=, twitter:title also via property=', () => {
    assert.equal(titleFromHtml('<meta name="og:title" content="og by name">'), 'og by name');
    assert.equal(titleFromHtml('<meta property="twitter:title" content="tw by property">'), 'tw by property');
  });

  test('may span lines, carry spacing around "=", and be self-closed', () => {
    const html = '<meta\n  property = "og:title"\n  content\n    = "Spread out"\n/>';
    assert.equal(titleFromHtml(html), 'Spread out');
    assert.equal(titleFromHtml('<meta property="og:title" content="Closed"/>'), 'Closed');
  });

  test('a ">" or "<" inside a quoted value does not end the tag', () => {
    assert.equal(titleFromHtml('<meta property="og:title" content="a > b">'), 'a > b');
    assert.equal(titleFromHtml("<meta content='1 < 2 > 0' property='og:title'>"), '1 < 2 > 0');
  });

  test('a meta tag without content is skipped', () => {
    assert.equal(titleFromHtml('<meta property="og:title"><title>Fallback</title>'), 'Fallback');
  });

  test('other meta tags and look-alikes are ignored', () => {
    const html = '<meta name="description" content="not a title">'
      + '<meta property="og:description" content="nope">'
      + '<meta property="og:title:extra" content="nope">'
      + '<metadata property="og:title" content="nope">';
    assert.equal(titleFromHtml(html), null);
  });

  test('when an attribute repeats, the first one wins', () => {
    assert.equal(titleFromHtml('<meta property="og:title" content="First" content="Second">'), 'First');
  });
});

describe('<title>', () => {
  test('may carry attributes', () => {
    assert.equal(titleFromHtml('<title id="t" data-rh=\'true\' lang=en>With attributes</title>'), 'With attributes');
  });

  test('may span lines; whitespace runs collapse to one space', () => {
    assert.equal(titleFromHtml('<title>\n   Two\n\t lines   here \r\n</title>'), 'Two lines here');
  });

  test('tag names are case-insensitive', () => {
    assert.equal(titleFromHtml('<TITLE>Up</TITLE>'), 'Up');
    assert.equal(titleFromHtml('<TiTlE>Mixed</tItLe >'), 'Mixed');
  });

  test('markup inside is text, not stripped or parsed', () => {
    assert.equal(titleFromHtml('<title>Fish <b>and</b> chips</title>'), 'Fish <b>and</b> chips');
  });

  test('one that is never closed gives nothing instead of swallowing the page', () => {
    assert.equal(titleFromHtml('<title>Never closed <p>rest of the page'), null);
    assert.equal(titleFromHtml('<meta property="og:title" content="Kept"><title>Open'), 'Kept');
  });
});

describe('what is not markup', () => {
  test('commented-out tags are ignored', () => {
    assert.equal(titleFromHtml('<!-- <title>Old</title> --><title>New</title>'), 'New');
    assert.equal(titleFromHtml('<!-- <meta property="og:title" content="Old"> --><title>New</title>'), 'New');
    assert.equal(titleFromHtml('<!--[if IE]><title>IE</title><![endif]--><title>Modern</title>'), 'Modern');
  });

  test('"<!-->" is an empty comment, as in browsers', () => {
    assert.equal(titleFromHtml('<!--><title>Visible</title>'), 'Visible');
  });

  test('an unclosed comment swallows the rest, but not what came before', () => {
    assert.equal(titleFromHtml('<title>Kept</title><!-- <title>Lost'), 'Kept');
    assert.equal(titleFromHtml('<!-- never closed <title>Lost</title>'), null);
  });

  test('text in <script> and <style> is not markup', () => {
    const html = '<script>var s = "<title>Fake</title>"; var m = \'<meta property="og:title" content="Fake">\';</script>'
      + '<style>/* <title>Fake</title> */</style><title>Real</title>';
    assert.equal(titleFromHtml(html), 'Real');
  });

  test('a script that contains "<!--" does not hide what follows it', () => {
    assert.equal(titleFromHtml('<script>var open = "<!--";</script><title>Still found</title>'), 'Still found');
  });

  test('stray "<" in text does not derail the scan', () => {
    assert.equal(titleFromHtml('a < b, and 3 <4 <title>Found</title>'), 'Found');
    assert.equal(titleFromHtml('<!doctype html><?xml version="1.0"?></p><title>Found</title>'), 'Found');
  });
});

describe('entities', () => {
  test('the named ones', () => {
    assert.equal(titleFromHtml('<title>&amp; &lt; &gt; &quot; &apos;</title>'), '& < > " \'');
  });

  test('numeric, decimal and hex, either case of x', () => {
    assert.equal(titleFromHtml('<title>&#39;hi&#39; &#8217; &#x2019; &#X2019; &#65;&#x42;</title>'), "'hi' ’ ’ ’ AB");
  });

  test('characters outside the BMP', () => {
    assert.equal(titleFromHtml('<title>&#128512; &#x1F600;</title>'), '😀 😀');
  });

  test('entities in attribute values are decoded too', () => {
    assert.equal(titleFromHtml('<meta property="og:title" content="Tom &amp; Jerry&#39;s &quot;Show&quot;">'),
      'Tom & Jerry\'s "Show"');
  });

  test('&nbsp; and numeric spaces fold into ordinary whitespace and are trimmed', () => {
    assert.equal(titleFromHtml('<title>&nbsp;&nbsp;a&nbsp;&nbsp;b&#32;&#10;c&nbsp;</title>'), 'a b c');
  });

  test('numbers that are not real characters become U+FFFD', () => {
    for (const ref of ['&#0;', '&#xD800;', '&#xDFFF;', '&#x110000;', '&#99999999999999999999;']) {
      assert.equal(titleFromHtml(`<title>x${ref}y</title>`), 'x�y', ref);
    }
  });

  test('anything else is left exactly as written', () => {
    const cases = ['&copy;', '&amp', '&#;', '&#x;', '&;', '& amp;', '&unknownentity;',
      '&constructor;', '&__proto__;', '&toString;', '&hasOwnProperty;'];
    for (const text of cases) assert.equal(titleFromHtml(`<title>${text}</title>`), text, text);
  });

  test('decoding happens once', () => {
    assert.equal(titleFromHtml('<title>&amp;lt; &amp;amp; &amp;#39;</title>'), '&lt; &amp; &#39;');
  });
});

describe('length', () => {
  test('120 characters or fewer are returned unchanged', () => {
    assert.equal(titleFromHtml(`<title>${'a'.repeat(120)}</title>`), 'a'.repeat(120));
    assert.equal(titleFromHtml('<title>short</title>'), 'short');
  });

  test('longer is cut so that the total, with the ellipsis, is exactly 120', () => {
    for (const n of [121, 122, 200, 5000]) {
      const out = titleFromHtml(`<title>${'a'.repeat(n)}</title>`);
      assert.equal(out.length, 120, `input of ${n}`);
      assert.equal(out, `${'a'.repeat(119)}…`);
    }
  });

  test('the cut never splits a surrogate pair', () => {
    // 118 letters, then emoji: the 119th and 120th units are one character, so the cut backs off.
    const out = titleFromHtml(`<title>${'a'.repeat(118)}${'😀'.repeat(10)}</title>`);
    assert.equal(out, `${'a'.repeat(118)}…`);
    assert.ok(out.isWellFormed());
    // Whole characters that do fit are kept.
    const roomy = titleFromHtml(`<title>${'a'.repeat(117)}${'😀'.repeat(10)}</title>`);
    assert.equal(roomy, `${'a'.repeat(117)}😀…`);
    assert.equal(roomy.length, 120);
  });

  test('length is judged after decoding and collapsing whitespace', () => {
    assert.equal(titleFromHtml(`<title>${'&amp;'.repeat(120)}</title>`), '&'.repeat(120));
    assert.equal(titleFromHtml(`<title>${'&amp;'.repeat(121)}</title>`), `${'&'.repeat(119)}…`);
    assert.equal(titleFromHtml(`<title>a${' '.repeat(500)}b</title>`), 'a b');
  });
});

describe('input', () => {
  test('anything that is not a string gives null', () => {
    for (const input of [undefined, null, 0, 42, true, {}, [], ['<title>x</title>'], Buffer.from('<title>x</title>')]) {
      assert.equal(titleFromHtml(input), null, String(typeof input));
    }
  });

  test('broken markup never throws', () => {
    const broken = ['<', '<<<<', '<meta', '<meta ', '<meta property=', '<meta property="og:title', '<meta "', "<meta '",
      '<title', '<title>', '</title>', '<!--', '<!', '<script', '<script>', '<a href="', '=====', '<meta =>',
      '<meta property="og:title" content=>', ' <title> </title>', '<title>&#</title>'];
    for (const html of broken) assert.doesNotThrow(() => titleFromHtml(html), JSON.stringify(html));
  });

  test('unbalanced quotes do not leak into other tags', () => {
    assert.equal(titleFromHtml('<meta property="og:title" content="Fine"><meta content="oops><title>T</title>'), 'Fine');
  });

  test('stays linear on pages built to make backtracking parsers crawl', () => {
    // The size links.js caps a download at: big enough that quadratic behaviour is many seconds.
    const size = 262144;
    const pages = {
      'meta never closed': '<meta '.repeat(size / 6),
      'quotes never closed': '<meta a="'.repeat(size / 9),
      'lone quote in every tag': '<meta "'.repeat(size / 7),
      'comments never closed': '<!--'.repeat(size / 4),
      'titles never closed': '<title>'.repeat(size / 7),
      'scripts never closed': '<script>'.repeat(size / 8),
      'only "<"': '<'.repeat(size),
      'names with no end': '<a<a<a<a'.repeat(size / 8),
      'only "&"': '&'.repeat(size),
      'entities never ended': '&#1234567890'.repeat(size / 12),
    };
    for (const [name, html] of Object.entries(pages)) {
      const started = performance.now();
      titleFromHtml(html);
      // Linear takes a few milliseconds; quadratic takes many seconds. The margin is for a loaded machine.
      assert.ok(performance.now() - started < 1000, `${name} took too long`);
    }
  });
});
