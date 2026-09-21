import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLinkTitles } from '../../src/ui/linkTitles.js';

// A requester over fakes: fetches are recorded and answered by whatever `answer` is; applied titles are recorded.
function setup(answer = () => Promise.resolve('A Page Title')) {
  const fetched = [];
  const applied = [];
  const links = createLinkTitles({
    fetchTitle: (href) => { fetched.push(href); return answer(href); },
    setLinkTitle: (id, url, title) => { applied.push([id, url, title]); },
  });
  return { links, fetched, applied };
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 5)); // let the promise chain run

test('a captured bare link is fetched, and the title applied to that item', async () => {
  const { links, fetched, applied } = setup();
  links.request('a1', 'https://example.com/article');
  await settle();
  assert.deepEqual(fetched, ['https://example.com/article']);
  assert.deepEqual(applied, [['a1', 'https://example.com/article', 'A Page Title']]);
});

test('a www. address is fetched as https://, but the title is applied against the text as written', async () => {
  const { links, fetched, applied } = setup();
  links.request('a1', 'www.example.org/page');
  await settle();
  assert.deepEqual(fetched, ['https://www.example.org/page']);
  assert.deepEqual(applied, [['a1', 'www.example.org/page', 'A Page Title']]);
});

test('the address passed back is the trimmed text (the store compares against the trimmed title)', async () => {
  const { links, fetched, applied } = setup();
  links.request('a1', '   https://example.com/x   ');
  await settle();
  assert.deepEqual(fetched, ['https://example.com/x']);
  assert.equal(applied[0][1], 'https://example.com/x');
});

test('text that is not just one link is never fetched', async () => {
  const { links, fetched } = setup();
  for (const text of ['buy milk', 'read https://example.com/a now', 'https://a.org and https://b.org', 'https://example.org.', 'example.com', 'javascript:alert(1)', '']) {
    links.request('a1', text);
  }
  await settle();
  assert.deepEqual(fetched, []);
});

test('nothing captured (a null id) or something that is not text is ignored', async () => {
  const { links, fetched } = setup();
  links.request(null, 'https://example.com/a');
  links.request(undefined, 'https://example.com/a');
  links.request('a1', undefined);
  links.request('a1', 42);
  links.request('a1', { text: 'https://example.com/a' });
  await settle();
  assert.deepEqual(fetched, []);
});

test('no title (null, blank, or not a string) applies nothing', async () => {
  for (const answer of [null, '', '   ', undefined, 42, {}]) {
    const { links, applied } = setup(() => Promise.resolve(answer));
    links.request('a1', 'https://example.com/a');
    await settle();
    assert.deepEqual(applied, [], String(answer));
  }
});

test('a failed fetch is silent: no title, and no unhandled rejection', async () => {
  const seen = [];
  const onUnhandled = (err) => seen.push(err);
  process.on('unhandledRejection', onUnhandled);
  try {
    const { links, applied } = setup(() => Promise.reject(new Error('offline')));
    links.request('a1', 'https://example.com/a');
    await settle();
    assert.deepEqual(applied, []);
    assert.deepEqual(seen, []);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('a fetch that throws at once is silent too', async () => {
  const { links, applied } = setup(() => { throw new Error('bridge is gone'); });
  links.request('a1', 'https://example.com/a');
  await settle();
  assert.deepEqual(applied, []);
});

test('a setLinkTitle that throws is contained', async () => {
  const links = createLinkTitles({
    fetchTitle: () => Promise.resolve('T'),
    setLinkTitle: () => { throw new Error('store exploded'); },
  });
  links.request('a1', 'https://example.com/a');
  await settle(); // reaching here without an unhandled rejection killing the run is the assertion
});

test('asking twice for the same item and address while the first is in flight is one fetch', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { links, fetched, applied } = setup(() => gate.then(() => 'Late Title'));
  links.request('a1', 'https://example.com/a');
  links.request('a1', 'https://example.com/a');
  release();
  await settle();
  assert.equal(fetched.length, 1);
  assert.equal(applied.length, 1);
});

test('once it has finished, the same request may be made again', async () => {
  const { links, fetched } = setup();
  links.request('a1', 'https://example.com/a');
  await settle();
  links.request('a1', 'https://example.com/a');
  await settle();
  assert.equal(fetched.length, 2);
});

test('different items asking for the same address are separate requests', async () => {
  const { links, fetched, applied } = setup();
  links.request('a1', 'https://example.com/a');
  links.request('a2', 'https://example.com/a');
  await settle();
  assert.equal(fetched.length, 2);
  assert.deepEqual(applied.map((a) => a[0]).sort(), ['a1', 'a2']);
});

test('a slow answer is applied when it arrives, however late', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { links, applied } = setup(() => gate.then(() => 'Slow Title'));
  links.request('a1', 'https://example.com/a');
  await settle();
  assert.deepEqual(applied, []);
  release();
  await settle();
  assert.deepEqual(applied, [['a1', 'https://example.com/a', 'Slow Title']]);
});
