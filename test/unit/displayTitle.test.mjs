import { test } from 'node:test';
import assert from 'node:assert/strict';
import { displayTitle } from '../../src/core/selectors.js';

const item = (text, extra = {}) => ({ id: 'a', text, ...extra });

test('a plain title reads as written', () => {
  assert.deepEqual(displayTitle(item('buy oat milk')), { kind: 'text', label: 'buy oat milk' });
});

test('a title with a link among other words is text (its link is clickable, but it is not "a link")', () => {
  assert.equal(displayTitle(item('read https://example.com/a now')).kind, 'text');
  assert.equal(displayTitle(item('https://a.org and https://b.org')).kind, 'text');
  assert.equal(displayTitle(item('https://example.org.')).kind, 'text', 'a full stop makes it a sentence');
});

test('a bare link without a fetched title shows the address, tidied', () => {
  assert.deepEqual(displayTitle(item('https://example.com/a/b')), {
    kind: 'link', label: 'example.com/a/b', href: 'https://example.com/a/b', domain: '',
  });
});

test('the tidy address drops the scheme, www., a trailing slash, the query and the fragment', () => {
  assert.equal(displayTitle(item('https://www.instagram.com/reel/DdVsabc/?igsh=xyz#top')).label, 'instagram.com/reel/DdVsabc');
  assert.equal(displayTitle(item('https://example.com/')).label, 'example.com');
  assert.equal(displayTitle(item('https://example.com')).label, 'example.com');
  assert.equal(displayTitle(item('http://sub.example.co.uk/x///')).label, 'sub.example.co.uk/x');
});

test('a www. address (no scheme) links to https:// and reads tidied', () => {
  assert.deepEqual(displayTitle(item('www.example.org/page')), {
    kind: 'link', label: 'example.org/page', href: 'https://www.example.org/page', domain: '',
  });
});

test('surrounding whitespace does not stop it being a bare link', () => {
  assert.equal(displayTitle(item('   https://example.com/a  ')).kind, 'link');
});

test('with a fetched page title, that is the label and the site goes beside it', () => {
  assert.deepEqual(displayTitle(item('https://www.example.com/2026/an-article', { linkTitle: 'An Article Worth Reading' })), {
    kind: 'link', label: 'An Article Worth Reading', href: 'https://www.example.com/2026/an-article', domain: 'example.com',
  });
});

test('a blank or non-string linkTitle is the same as none', () => {
  for (const linkTitle of ['', '   ', undefined, null, 42, {}]) {
    const d = displayTitle(item('https://example.com/a', { linkTitle }));
    assert.equal(d.label, 'example.com/a', String(linkTitle));
    assert.equal(d.domain, '');
  }
});

test('a linkTitle on an item whose title is not a bare link is ignored', () => {
  assert.deepEqual(displayTitle(item('call the vet', { linkTitle: 'Stale' })), { kind: 'text', label: 'call the vet' });
});

test('an escaped path is shown readably, and a malformed escape does not throw', () => {
  assert.equal(displayTitle(item('https://en.wikipedia.org/wiki/Caf%C3%A9')).label, 'en.wikipedia.org/wiki/Café');
  assert.doesNotThrow(() => displayTitle(item('https://example.com/100%')));
  assert.equal(displayTitle(item('https://example.com/100%')).kind, 'link');
});

test('a missing or odd item gives empty text, not a crash', () => {
  for (const bad of [undefined, null, {}, { text: 42 }, { text: null }]) {
    assert.deepEqual(displayTitle(bad), { kind: 'text', label: '' }, JSON.stringify(bad));
  }
});

test('it does not change the item it is given', () => {
  const it = Object.freeze(item('https://example.com/a', { linkTitle: 'T' }));
  assert.doesNotThrow(() => displayTitle(it));
});
