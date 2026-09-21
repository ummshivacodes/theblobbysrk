import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOpenBodies } from '../../src/ui/views/bodyEditor.js';

test('nothing is open to begin with, and nothing wants the caret', () => {
  const open = createOpenBodies();
  assert.equal(open.isOpen('a'), false);
  assert.equal(open.takeAutofocus(), null);
});

test('toggle opens a body, and toggling again closes it', () => {
  const open = createOpenBodies();
  open.toggle('a');
  assert.equal(open.isOpen('a'), true);
  open.toggle('a');
  assert.equal(open.isOpen('a'), false);
});

test('opening a body asks for the caret once; asking clears it', () => {
  const open = createOpenBodies();
  open.toggle('a');
  assert.equal(open.takeAutofocus(), 'a');
  assert.equal(open.takeAutofocus(), null);
  assert.equal(open.isOpen('a'), true, 'still open after the caret was handed out');
});

test('closing a body withdraws a caret request that was never collected', () => {
  const open = createOpenBodies();
  open.toggle('a');
  open.toggle('a');
  assert.equal(open.takeAutofocus(), null);
});

test('the caret goes to the body opened last', () => {
  const open = createOpenBodies();
  open.toggle('a');
  open.toggle('b');
  assert.equal(open.takeAutofocus(), 'b');
});

test('prune forgets items that left the list and keeps the others', () => {
  const open = createOpenBodies();
  ['a', 'b', 'c'].forEach((id) => open.toggle(id));
  open.prune(new Set(['a', 'c']));
  assert.deepEqual(['a', 'b', 'c'].map((id) => open.isOpen(id)), [true, false, true]);
});

test('two lists keep separate state', () => {
  const inbox = createOpenBodies();
  const notes = createOpenBodies();
  inbox.toggle('a');
  assert.equal(notes.isOpen('a'), false);
});
