import { inboxItems } from '../../core/selectors.js';
import { createOpenBodies, isEditingIn } from './bodyEditor.js';
import { buildRow } from './itemRow.js';

// The main list ("Task dump"): every item that isn't a note, oldest first, each with the controls
// that fit its status. Owns the UI state that must not live on the data: which rows are being retagged
// and which are expanded to show their body.
//   els = { list, count }
//   actions = { tag, push, recall, resolve, reopen, focus, remove, setBody, fileNote, openLink, hover, openMenu(x, y, entries) }
const clip = (text) => (text.length > 24 ? `${text.slice(0, 23)}…` : text);

export function createInboxView({ list, count }, actions) {
  const retagging = new Set(); // ids whose chip was clicked and now show the four dots again
  const openBodies = createOpenBodies(); // which rows have their ▸ open, so their body shows under the row
  let last = null;             // the latest render, so a click here can redraw just this list

  // Right-click entries for one item: Reopen (crossed off only) and Delete.
  function menuEntries(item) {
    const entries = [];
    if (item.status === 'done') {
      entries.push({ label: 'Reopen', className: 'reopen', onSelect: () => actions.reopen(item.id) });
    }
    entries.push({ label: `Delete "${clip(item.text)}"`, onSelect: () => actions.remove(item.id) });
    return entries;
  }

  const handlers = {
    tag: (id, q) => { retagging.delete(id); actions.tag(id, q); },
    startRetag: (id) => { retagging.add(id); redraw(); },
    toggleExpand: (id) => { openBodies.toggle(id); redraw(); },
    saveBody: actions.setBody,
    fileNote: actions.fileNote,
    openLink: actions.openLink,
    push: actions.push,
    recall: actions.recall,
    resolve: actions.resolve,
    reopen: actions.reopen,
    focus: actions.focus,
    hover: actions.hover,
    menu: (x, y, item) => actions.openMenu(x, y, menuEntries(item)),
  };

  function render(snapshot, ui) {
    // freshId is a one-render highlight; a later redraw of this list alone must not repeat it.
    last = { snapshot, ui: { ...ui, freshId: null } };
    const items = inboxItems(snapshot);
    const present = new Set(items.map((item) => item.id));
    retagging.forEach((id) => { if (!present.has(id)) retagging.delete(id); });
    openBodies.prune(present);
    const autofocus = openBodies.takeAutofocus();

    // Clearing the list collapses it, which throws the scroll position away: keep it.
    const scrolled = list.scrollTop;
    count.textContent = `(${items.length})`;
    list.innerHTML = '';
    items.forEach((item) => {
      list.appendChild(buildRow(item, {
        retagging: retagging.has(item.id),
        fresh: item.id === ui.freshId,
        expanded: openBodies.isOpen(item.id),
        autofocusBody: item.id === autofocus,
        handlers,
      }));
    });
    list.scrollTop = ui.freshId ? list.scrollHeight : scrolled;
  }

  function redraw() {
    render(last.snapshot, last.ui);
  }

  // Hover sync repaints only this view's own rows.
  function applyHover(id) {
    list.querySelectorAll('.task-row[data-id]').forEach((row) => {
      row.classList.toggle('hovered', row.dataset.id === id);
    });
  }

  // Is the user typing in one of this list's body editors? (Then it must not be redrawn under them.)
  const isEditing = () => isEditingIn(list);

  return { render, applyHover, isEditing };
}
