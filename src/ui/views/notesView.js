import { notes as allNotes, searchNotes } from '../../core/selectors.js';
import { el } from '../dom.js';
import { createOpenBodies, isEditingIn } from './bodyEditor.js';
import { buildRow } from './itemRow.js';
import { createRename } from './titleEditor.js';

// The Notes screen: a search box over the notes, newest edit first (or however you last dragged them —
// see the `reorderable` row option below; the actual drag mechanics are ui/dragList.js, owned by
// app.js like every other cross-cutting gesture controller, not imported here). A note is a row like any
// other (open it with ▸ or by clicking its title, to read or edit its body) with two differences: no tag
// (a note is never on the axis) and a ↩ that sends it back to the task dump.
// It owns the UI state that must not live on the data: the search text and which notes are open.
// Dragging is turned off while a search is showing (see render): reordering a filtered subset doesn't
// have a clear meaning, since most of the group isn't even on screen to drag past.
//
// None of that UI-only state goes through the render gate (it never touches the store), but it still
// must not repaint the list out from under an active drag — see redraw()/flushIfPending() — so app.js
// calls flushIfPending() once it hears the Notes list's drag has ended.
//   els = { search, list, count }
//   actions = { unfile, remove, setBody, openLink, rename, openMenu(x, y, entries) }
const clip = (text) => (text.length > 24 ? `${text.slice(0, 23)}…` : text);

export function createNotesView({ search, list, count }, actions) {
  const openBodies = createOpenBodies();
  const renaming = createRename();
  let query = '';
  let last = null;          // the latest snapshot, so a click here can redraw just this list
  let redrawPending = false; // a UI-only change (search, expand, rename) arrived while a drag held it back

  search.addEventListener('input', () => {
    query = search.value;
    redraw();
  });

  const handlers = {
    toggleExpand: (id) => { openBodies.toggle(id); redraw(); },
    saveBody: actions.setBody,
    unfile: actions.unfile,
    openLink: actions.openLink,
    rename: actions.rename,
    startRename: (id) => { renaming.begin(id); redraw(); },
    endRename: () => { renaming.end(); redraw(); },
    menu: (x, y, item) => actions.openMenu(x, y, [
      { label: `Delete "${clip(item.text)}"`, onSelect: () => actions.remove(item.id) },
    ]),
  };

  function render(snapshot) {
    last = snapshot;
    const everything = allNotes(snapshot);
    const shown = searchNotes(snapshot, query);
    const present = new Set(everything.map((note) => note.id));
    openBodies.prune(present);
    renaming.prune(present);
    const autofocus = openBodies.takeAutofocus();
    const searching = query.trim() !== '';

    count.textContent = searching ? `(${shown.length} of ${everything.length})` : `(${everything.length})`;
    const scrolled = list.scrollTop; // clearing the list throws the scroll position away: keep it
    list.innerHTML = '';
    if (shown.length === 0) {
      list.appendChild(el('div', {
        className: 'notes-empty',
        text: searching
          ? `No notes match “${query.trim()}”.`
          : 'No notes yet. Type one below, or press ⌘↵ in the capture box on the main screen.',
      }));
      return;
    }
    shown.forEach((note) => {
      list.appendChild(buildRow(note, {
        retagging: false,
        fresh: false,
        expanded: openBodies.isOpen(note.id),
        autofocusBody: note.id === autofocus,
        renaming: renaming.isRenaming(note.id),
        reorderable: !searching,
        handlers,
      }));
    });
    list.scrollTop = scrolled;
  }

  // A local, UI-only change (the search text, which body is open, which title is being renamed) needs
  // this list repainted, but not through the render gate: none of these touch the store. Rebuilding the
  // whole list is exactly what must NOT happen while a drag (ui/dragList.js) is moving one of its own
  // rows — the row it is mid-move would be torn out from under it — and that can genuinely happen: one
  // hand drags with the mouse while the other ends an already-open rename with Enter, or keeps typing in
  // the (still-focused) search box, both entirely ordinary. So: skip while a `.dragging` row is present,
  // remember to catch up, and catch up the moment app.js reports the drag is over (flushIfPending).
  function redraw() {
    if (!last) return;
    if (list.querySelector('.task-row.dragging')) { redrawPending = true; return; }
    redrawPending = false;
    render(last);
  }

  // Called by app.js once the Notes list's drag has ended (however it ended): if a redraw was held back
  // because of it, it is safe now.
  function flushIfPending() {
    if (redrawPending) redraw();
  }

  // Empty the search box (a note added while a search was showing would otherwise be hidden by it).
  function clearSearch() {
    query = '';
    search.value = '';
    redraw();
  }

  // The screen was just opened: start from all the notes, with the caret in the search box.
  function open() {
    clearSearch();
    search.focus();
  }

  // Is the user typing in one of this list's body editors? (Then it must not be redrawn under them.)
  const isEditing = () => isEditingIn(list);

  return { render, open, clearSearch, isEditing, flushIfPending };
}
