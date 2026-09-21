import { el } from '../dom.js';
import { EDIT_ENDED } from './bodyEditor.js';

// Renaming an item: double-click its title and it becomes a text box holding the words or the address as they
// are stored (a link reads as its page title, but it is the link you edit). Enter or clicking away saves; Esc
// leaves it as it was (a title is a few words: the usual "Esc cancels" is safe here, unlike in a note).
// Like the notes editor, every way out is one blur, and the save happens a microtask later so that a focus
// move (to another editor, say) completes before the save redraws the list.

// What renaming to `value` should do: the new title, or null when there is nothing to change (blank, or the
// same as now). The store refuses both anyway; not asking also avoids a pointless title fetch for an
// unchanged link.
export function renamedTo(item, value) {
  const next = typeof value === 'string' ? value.trim() : '';
  return next !== '' && next !== item.text ? next : null;
}

// Which item's title is open for editing in one list (at most one).
export function createRename() {
  let renaming = null;
  return {
    isRenaming: (id) => renaming === id,
    begin(id) { renaming = id; },
    end() { renaming = null; },
    // Forget it if that item has left the list (`present` is a Set of ids).
    prune(present) { if (renaming !== null && !present.has(renaming)) renaming = null; },
  };
}

// item: the item being renamed. actions: { rename(id, text), end() }: rename saves (only ever called with a
// real change), end tells the list this edit is over so it draws the plain title again.
export function createTitleEditor({ item }, { rename, end }) {
  const input = el('input', { className: 'title-edit', attrs: { type: 'text', spellcheck: 'false' }, dataset: { editor: 'title' } });
  input.value = item.text;
  let cancelled = false;
  let finished = false;

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) {
      e.preventDefault();
      e.stopPropagation();
      input.blur();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation(); // Esc here ends the rename; it must not also close the panel or leave the screen
      cancelled = true;
      input.blur();
    }
  });

  input.addEventListener('blur', () => {
    if (finished) return;
    finished = true;
    const next = cancelled ? null : renamedTo(item, input.value);
    // Announce BEFORE the list is redrawn: drawing the plain title takes this box out of the page, and an
    // event from a node that is not in the page never reaches the document.
    input.dispatchEvent(new CustomEvent(EDIT_ENDED, { bubbles: true }));
    end();
    if (next) queueMicrotask(() => rename(item.id, next));
  });

  // Not synchronous: on the first draw the box isn't in the page yet, and a detached input can't take focus.
  queueMicrotask(() => {
    if (!input.isConnected) return;
    input.focus();
    input.select();
  });
  return input;
}
