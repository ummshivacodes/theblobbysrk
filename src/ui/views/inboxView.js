import { inboxItems } from '../../core/selectors.js';
import { buildRow } from './itemRow.js';

// The main list ("Task dump"): every item that isn't a note, oldest first, each with the controls
// that fit its status. Owns the one piece of UI state that used to be smuggled onto the data itself:
// which rows are being retagged.
//   els = { list, count }
//   actions = { tag, push, recall, resolve, reopen, focus, remove, hover, openMenu(x, y, entries) }
const clip = (text) => (text.length > 24 ? `${text.slice(0, 23)}…` : text);

export function createInboxView({ list, count }, actions) {
  const retagging = new Set(); // ids whose chip was clicked and now show the four dots again
  let last = null;             // the latest render, so a retag click can redraw just this list

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

    count.textContent = `(${items.length})`;
    list.innerHTML = '';
    items.forEach((item) => {
      list.appendChild(buildRow(item, {
        retagging: retagging.has(item.id),
        fresh: item.id === ui.freshId,
        handlers,
      }));
    });
    if (ui.freshId) list.scrollTop = list.scrollHeight;
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

  return { render, applyHover };
}
