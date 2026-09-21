import { linkify } from '../../core/linkify.js';
import { el, renderSegments } from '../dom.js';

// The body of one item, under its row: the text as written (read mode) that turns into a textarea when
// you click it (edit mode). Used by every list that shows items, so a task and a note edit the same way.
//
// Saving never needs a button:
//   - it saves as you type, SAVE_IDLE_MS after the last keystroke (so quitting with ⌘Q mid-sentence
//     loses almost nothing);
//   - it saves, and goes back to read mode, the moment focus leaves (clicking elsewhere, another app,
//     the panel folding away) and on ⌘↵ or Esc.
// Esc keeps what you typed, on purpose: in a note taker the costly mistake is silently throwing text
// away, not keeping a few characters you didn't want.
//
// It keeps only throw-away UI state (the draft, the mode). Whatever the data is, it arrives as `item`;
// the only way out is the `save` action.

// How long after the last keystroke the draft is saved. Short enough that little is at risk, long
// enough that a burst of typing is one save.
export const SAVE_IDLE_MS = 800;

// Announced (bubbling, from the editor's own node) every time an edit ends, whichever way it ended. The
// composition root listens: a redraw that was held back while the user typed is due now. It has to be
// an event of ours: the browser's own focusout is not reliable for this, because the editor swaps its
// textarea out DURING blur, so focusout is then fired at a node that is no longer in the page.
export const EDIT_ENDED = 'blob:edit-ended';

// Is the user typing in an editor (a body, or a title being renamed) somewhere inside `container`? A list
// uses this to tell the composition root "don't redraw me right now". Every editor marks its text box with
// data-editor, so this needn't know what kinds there are.
export function isEditingIn(container) {
  const active = document.activeElement;
  return !!active && active.dataset && active.dataset.editor !== undefined && container.contains(active);
}

// Which items have their body open, for one list. Opening the body of an item that has none takes the
// caret, once (on the next draw), so you can start typing at once.
export function createOpenBodies() {
  const open = new Set();
  let autofocus = null;
  return {
    isOpen: (id) => open.has(id),
    toggle(id) {
      if (open.delete(id)) autofocus = null;
      else { open.add(id); autofocus = id; }
    },
    // Forget items that are no longer in the list (`present` is a Set of ids).
    prune(present) { open.forEach((id) => { if (!present.has(id)) open.delete(id); }); },
    // The id whose editor should take the caret on the coming draw; asking clears it.
    takeAutofocus() {
      const id = autofocus;
      autofocus = null;
      return id;
    },
  };
}

const trimEnd = (text) => text.replace(/\s+$/, '');
const hasSelection = () => !!window.getSelection && window.getSelection().toString() !== '';

// item: the item being shown ({ id, body?, status }).
// options: { readOnly?: boolean (no editing, e.g. while a task is mid-close), autofocus?: boolean }
// actions: { save(body), openLink(href) }  — save is called with the draft (the store decides what is
// stored); openLink is for a link clicked in the text.
export function createBodyEditor({ item, readOnly = false, autofocus = false }, { save, openLink }) {
  const node = el('div', { className: 'body-area' });
  let mode = 'read';           // 'read' | 'edit'
  let stored = item.body ?? ''; // what was last handed to save(), so an unchanged draft saves nothing
  let draft = stored;
  let idleTimer = null;
  let composing = false;       // an input method (Japanese, Chinese...) is mid-word: don't save half a character

  function commit() {
    clearTimeout(idleTimer);
    idleTimer = null;
    if (draft === stored) return;
    stored = draft;
    save(draft);
  }

  function scheduleSave() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(commit, SAVE_IDLE_MS);
  }

  function showRead() {
    mode = 'read';
    const text = trimEnd(draft);
    const read = el('div', { className: `body-read${text ? '' : ' empty'}` });
    if (text) renderSegments(read, linkify(text), { onLink: openLink });
    else read.textContent = 'No notes';
    if (!readOnly) {
      read.title = 'Click to edit';
      read.setAttribute('tabindex', '0');
      read.setAttribute('role', 'button');
      // A click that ends a text selection is for copying, not for editing.
      read.onclick = () => { if (!hasSelection()) showEdit(true); };
      read.onkeydown = (e) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        showEdit(true);
      };
    }
    node.replaceChildren(read);
  }

  // Leaving edit mode is always a blur, so there is one path for every way out (click elsewhere, other
  // app, panel folding, ⌘↵, Esc). Empty stays a textarea: an item with no notes has nothing to read.
  function leave() {
    if (mode !== 'edit') return; // also stops the blur that removing a focused textarea can fire
    if (trimEnd(draft)) showRead();
    // Announce BEFORE saving: saving redraws the list, which takes this node out of the page, and an
    // event from a node that is not in the page never reaches the document.
    node.dispatchEvent(new CustomEvent(EDIT_ENDED, { bubbles: true }));
    // Save one microtask later, not now. A blur is often half of a focus MOVE, from this editor to another
    // one. Saving redraws the list; a redraw in the middle of the move would destroy the editor that focus
    // is moving to. A microtask later the move is over, the new editor has focus, and the redraw waits
    // for it (renderGate). Still before the next event, so nothing is at risk.
    queueMicrotask(commit);
  }

  function showEdit(focus) {
    mode = 'edit';
    const area = el('textarea', {
      className: 'body-edit',
      attrs: { placeholder: 'Add notes…', rows: 3 },
      dataset: { editor: 'body' },
    });
    area.value = draft;
    area.addEventListener('input', () => {
      draft = area.value;
      if (!composing) scheduleSave();
    });
    area.addEventListener('compositionstart', () => { composing = true; });
    area.addEventListener('compositionend', () => {
      composing = false;
      draft = area.value;
      scheduleSave();
    });
    area.addEventListener('keydown', (e) => {
      const done = e.key === 'Escape' || (e.key === 'Enter' && e.metaKey);
      if (!done) return;
      e.preventDefault();
      e.stopPropagation(); // Esc here ends the edit; it must not also close the panel or leave the screen
      area.blur();
    });
    area.addEventListener('blur', leave);
    node.replaceChildren(area, el('div', { className: 'body-hint', text: '⌘↵ done · saves as you type' }));
    if (focus) {
      // Not synchronous: on the first draw the node isn't in the page yet, and a detached textarea can't
      // take focus.
      queueMicrotask(() => {
        if (!area.isConnected) return;
        area.focus();
        area.setSelectionRange(area.value.length, area.value.length);
        area.scrollIntoView({ block: 'nearest' });
      });
    }
  }

  // No notes yet: go straight to the textarea. Notes already there: show them, click to edit.
  if (readOnly || trimEnd(draft)) showRead();
  else showEdit(autofocus);

  return { node };
}
