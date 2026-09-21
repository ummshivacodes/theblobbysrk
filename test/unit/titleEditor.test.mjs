import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRename, renamedTo } from '../../src/ui/views/titleEditor.js';

const item = { id: 'a', text: 'buy oat milk' };

test('renaming to different words gives the new title, trimmed', () => {
  assert.equal(renamedTo(item, 'buy soy milk'), 'buy soy milk');
  assert.equal(renamedTo(item, '   buy soy milk  '), 'buy soy milk');
});

test('the same title, or the same with spaces round it, changes nothing', () => {
  assert.equal(renamedTo(item, 'buy oat milk'), null);
  assert.equal(renamedTo(item, '  buy oat milk  '), null);
});

test('a blank title changes nothing (a title can never be blank)', () => {
  for (const blank of ['', '   ', '\n', '\t ']) assert.equal(renamedTo(item, blank), null, JSON.stringify(blank));
});

test('something that is not text changes nothing', () => {
  for (const bad of [undefined, null, 42, {}, []]) assert.equal(renamedTo(item, bad), null, String(bad));
});

test('a different case is a change', () => {
  assert.equal(renamedTo(item, 'Buy oat milk'), 'Buy oat milk');
});

test('renaming to a link is allowed (the caller asks for its page title)', () => {
  assert.equal(renamedTo(item, 'https://example.com/a'), 'https://example.com/a');
});

test('nothing is being renamed to begin with', () => {
  const rename = createRename();
  assert.equal(rename.isRenaming('a'), false);
});

test('begin marks one item, end clears it', () => {
  const rename = createRename();
  rename.begin('a');
  assert.equal(rename.isRenaming('a'), true);
  assert.equal(rename.isRenaming('b'), false);
  rename.end();
  assert.equal(rename.isRenaming('a'), false);
});

test('only one title is renamed at a time: beginning another moves it', () => {
  const rename = createRename();
  rename.begin('a');
  rename.begin('b');
  assert.equal(rename.isRenaming('a'), false);
  assert.equal(rename.isRenaming('b'), true);
});

test('prune forgets a rename whose item has left the list, and keeps one that is still there', () => {
  const rename = createRename();
  rename.begin('a');
  rename.prune(new Set(['b']));
  assert.equal(rename.isRenaming('a'), false);
  rename.begin('a');
  rename.prune(new Set(['a', 'b']));
  assert.equal(rename.isRenaming('a'), true);
});

test('prune with nothing being renamed is harmless', () => {
  const rename = createRename();
  assert.doesNotThrow(() => rename.prune(new Set()));
});
