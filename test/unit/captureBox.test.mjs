import { test } from 'node:test';
import assert from 'node:assert/strict';
import { interpretKey } from '../../src/ui/captureBox.js';

const enter = (extra = {}) => ({ key: 'Enter', metaKey: false, shiftKey: false, ctrlKey: false, altKey: false, isComposing: false, ...extra });

test('Enter captures the text as a task', () => {
  assert.deepEqual(interpretKey(enter(), 'buy oat milk'), { text: 'buy oat milk', body: '', asNote: false });
});

test('⌘+Enter captures it as a note', () => {
  assert.deepEqual(interpretKey(enter({ metaKey: true }), 'buy oat milk'), { text: 'buy oat milk', body: '', asNote: true });
});

test('in a box that only takes notes, plain Enter is a note too', () => {
  const r = interpretKey(enter(), 'an idea', { enterMeansNote: true });
  assert.equal(r.asNote, true);
  assert.equal(interpretKey(enter({ metaKey: true }), 'an idea', { enterMeansNote: true }).asNote, true);
});

test('several lines: the first is the title, the rest the body, for a task and for a note', () => {
  const raw = 'sprint retro\nwhat went well\nwhat did not';
  assert.deepEqual(interpretKey(enter(), raw), { text: 'sprint retro', body: 'what went well\nwhat did not', asNote: false });
  assert.deepEqual(interpretKey(enter({ metaKey: true }), raw), { text: 'sprint retro', body: 'what went well\nwhat did not', asNote: true });
});

test('leading blank lines are skipped and Windows line endings are handled (what a paste brings)', () => {
  assert.deepEqual(interpretKey(enter(), '\r\n\r\ntitle\r\nline two\r\n'), { text: 'title', body: 'line two', asNote: false });
});

test('a key that is not Enter is not ours', () => {
  assert.equal(interpretKey({ key: 'a' }, 'text'), null);
  assert.equal(interpretKey({ key: 'Escape' }, 'text'), null);
  assert.equal(interpretKey({ key: 'Tab' }, 'text'), null);
});

test('Shift+Enter is a new line, not a capture', () => {
  assert.equal(interpretKey(enter({ shiftKey: true }), 'text'), null);
  assert.equal(interpretKey(enter({ shiftKey: true, metaKey: true }), 'text'), null);
});

test('Enter while an input method is composing confirms the word and captures nothing', () => {
  assert.equal(interpretKey(enter({ isComposing: true }), 'にほん'), null);
  assert.equal(interpretKey(enter({ isComposing: true, metaKey: true }), 'にほん'), null);
});

test('Ctrl+Enter and Alt+Enter are left to the browser', () => {
  assert.equal(interpretKey(enter({ ctrlKey: true }), 'text'), null);
  assert.equal(interpretKey(enter({ altKey: true }), 'text'), null);
});

test('an empty or blank box is consumed but captures nothing (so Enter cannot type a newline into it)', () => {
  for (const raw of ['', '   ', '\n\n', ' \n \n ']) {
    assert.deepEqual(interpretKey(enter(), raw), { text: '', body: '', asNote: false }, JSON.stringify(raw));
    assert.equal(interpretKey(enter({ metaKey: true }), raw).text, '');
  }
});

test('a box that is not a string is treated as empty, not as a crash', () => {
  assert.equal(interpretKey(enter(), undefined).text, '');
  assert.equal(interpretKey(enter(), null).text, '');
});

test('surrounding spaces are trimmed from the title', () => {
  assert.equal(interpretKey(enter(), '   spaced out   ').text, 'spaced out');
});
