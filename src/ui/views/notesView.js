import { notes as allNotes, searchNotes } from '../../core/selectors.js';
import { el } from '../dom.js';
import { createOpenBodies, isEditingIn } from './bodyEditor.js';
import { buildRow } from './itemRow.js';

// The Notes screen: a search box over the notes, newest edit first. A note is a row like any other (open
// it with ▸ or by clicking its title, to read or edit its body) with two differences: no tag (a note is
// never on the axis) and a ↩ that sends it back to the task dump.
// It owns the UI state that must not live on the data: the search text and which notes are open.
//   els = { search, list, count }
//   actions = { unfile, remove, setBody, openMenu(x, y, entries) }
const clip = (text) => (text.length > 24 ? `${text.slice(0, 23)}…` : text);

export function createNotesView({ search, list, count }, actions) {
  const openBodies = createOpenBodies();
  let query = '';
  let last = null; // the latest snapshot, so a click here can redraw just this list

  search.addEventListener('input', () => {
    query = search.value;
    if (last) render(last);
  });

  const handlers = {
    toggleExpand: (id) => { openBodies.toggle(id); redraw(); },
    saveBody: actions.setBody,
    unfile: actions.unfile,
    menu: (x, y, item) => actions.openMenu(x, y, [
      { label: `Delete "${clip(item.text)}"`, onSelect: () => actions.remove(item.id) },
    ]),
  };

  function render(snapshot) {
    last = snapshot;
    const everything = allNotes(snapshot);
    const shown = searchNotes(snapshot, query);
    openBodies.prune(new Set(everything.map((note) => note.id)));
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
        handlers,
      }));
    });
    list.scrollTop = scrolled;
  }

  function redraw() {
    if (last) render(last);
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

  return { render, open, clearSearch, isEditing };
}
