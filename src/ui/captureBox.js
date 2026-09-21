import { parseCapture } from '../core/capture.js';

// The box you type a thought into. It is a textarea, not a one-line input: a pasted block of lines keeps
// its line breaks (a one-line input flattens them before any handler could see them), and the first line
// becomes the title and the rest the notes (core/capture.js decides that).
//
// What a key press means is decided by interpretKey, a pure function (no DOM), so it is tested in plain
// Node. createCaptureBox is only the wiring.

// Enter is a task, ⌘+Enter is a note. In a box that only takes notes (the Notes screen), plain Enter is a
// note too. Not ours, so null and the browser does what it always does: Shift+Enter (a new line), Enter
// while an input method is composing (it confirms the word being typed, e.g. Japanese or Chinese), and
// Ctrl/Alt+Enter.
// Otherwise { text, body, asNote }. text is '' when the box holds nothing worth capturing; the key is
// still consumed then, so it does not type a newline into an empty box.
export function interpretKey(e, raw, { enterMeansNote = false } = {}) {
  if (e.key !== 'Enter' || e.isComposing || e.shiftKey || e.ctrlKey || e.altKey) return null;
  const { text, body } = parseCapture(raw);
  return { text, body, asNote: !!e.metaKey || enterMeansNote };
}

// box: the textarea. onCapture({ text, body, asNote }) is called for a real capture; the box is cleared
// afterwards.
export function createCaptureBox(box, { onCapture, enterMeansNote = false }) {
  box.addEventListener('keydown', (e) => {
    const capture = interpretKey(e, box.value, { enterMeansNote });
    if (!capture) return;
    e.preventDefault();
    if (!capture.text) return;
    onCapture(capture);
    box.value = '';
  });
}
