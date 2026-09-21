import { el } from '../dom.js';
import { firstLine, fmtAgo } from '../format.js';
import { COLORS } from '../theme.js';
import { createBodyEditor } from './bodyEditor.js';

// One row of a list: an expander, the title, a tag control, and the action button(s) that fit the item's
// status; expanded, the item's body sits under it. Pure construction: it never touches the store, and
// every interaction goes out through `handlers`:
//   { tag(id, q), startRetag(id), push(id), recall(id), resolve(id), reopen(id), focus(id),
//     hover(id | null), menu(x, y, item), toggleExpand(id), saveBody(id, body), fileNote(id), unfile(id) }

// A round action button; clicking it must not also count as a click on the row.
function actionButton(className, text, title, run) {
  return el('button', {
    className: `task-act ${className}`,
    text,
    title,
    onclick: (e) => { e.stopPropagation(); run(); },
  });
}

// Untagged: four dots (Q1..Q4), and for an item still in the dump a fifth, N: it isn't a task at all, so
// file it as a note (it leaves this list). N is not a .tag-dot on purpose: it files the item rather than
// labelling it, and an axis thread can't be filed (it has to be recalled to the dump first).
function tagDots(item, handlers) {
  const dots = el('div', { className: 'tag-dots' });
  [1, 2, 3, 4].forEach((q) => {
    const dot = el('button', {
      className: 'tag-dot',
      text: `Q${q}`,
      title: `Tag Q${q}`,
      onclick: (e) => { e.stopPropagation(); handlers.tag(item.id, q); },
    });
    dot.style.setProperty('--c', COLORS[q]);
    dots.appendChild(dot);
  });
  if (item.status === 'dump') {
    dots.appendChild(el('button', {
      className: 'note-dot',
      text: 'N',
      title: 'File as a note (not a task): moves it to your notes',
      onclick: (e) => { e.stopPropagation(); handlers.fileNote(item.id); },
    }));
  }
  return dots;
}

// Tag state: crossed off → a fixed chip; untagged (or being retagged) → the dots; tagged → one chip
// (click it to retag).
function tagControl(item, retagging, handlers) {
  if (item.status === 'done') {
    const chip = el('span', { className: `tag-chip q${item.quad} static`, text: `Q${item.quad}` });
    chip.style.setProperty('--c', COLORS[item.quad]);
    return chip;
  }
  if (item.quad == null || retagging) return tagDots(item, handlers);
  const chip = el('button', { className: `tag-chip q${item.quad}`, text: `Q${item.quad}`, title: 'Retag' });
  chip.style.setProperty('--c', COLORS[item.quad]);
  chip.onclick = (e) => { e.stopPropagation(); handlers.startRetag(item.id); };
  return chip;
}

// Dump + tagged → → pushes it onto the axis; on the axis → ← recalls it to the dump and ✓ closes the
// loop; crossed off → ↺ reopens it.
function actionButtons(item, handlers) {
  // A note has no tag and never goes on the axis. ↩ sends it back to the dump, where it is a task again.
  if (item.status === 'note') {
    return [actionButton('unfile', '↩', 'Back to the task dump', () => handlers.unfile(item.id))];
  }
  if (item.status === 'done') {
    return [actionButton('undo', '↺', 'Reopen (undo cross-off)', () => handlers.reopen(item.id))];
  }
  if (item.status === 'axis') {
    return [
      actionButton('recall', '←', 'Not working on this yet — send back to the dump', () => handlers.recall(item.id)),
      actionButton('done', '✓', 'Close this thread', () => handlers.resolve(item.id)),
    ];
  }
  if (item.status === 'dump' && item.quad != null) {
    return [actionButton('push', '→', 'Put on the axis', () => handlers.push(item.id))];
  }
  return [];
}

// ▸ opens the item's body under the row; it is brighter when there is a body to read. It is its own
// kind of button (not a .task-act): it is about the item's contents, not about what state it is in.
function expander(item, expanded, handlers) {
  return el('button', {
    className: `row-expander${item.body ? ' has-body' : ''}${expanded ? ' open' : ''}`,
    text: '▸',
    title: expanded ? 'Hide notes' : item.body ? 'Show notes' : 'Add notes',
    attrs: { 'aria-expanded': expanded },
    onclick: (e) => { e.stopPropagation(); handlers.toggleExpand(item.id); },
  });
}

// A note's second line: the first line of its body (only while it is closed: open, the body is right
// there) and when it was last edited.
function noteMeta(item, expanded) {
  const meta = el('div', { className: 'note-meta' });
  const snippet = expanded ? '' : firstLine(item.body);
  if (snippet) meta.appendChild(el('span', { className: 'note-snippet', text: snippet }));
  const when = fmtAgo(item.updatedAt ?? item.createdAt);
  if (when) meta.appendChild(el('span', { className: 'note-when', text: `edited ${when}` }));
  return meta;
}

// opts = { retagging: boolean, fresh: boolean, expanded: boolean, autofocusBody: boolean, handlers }
export function buildRow(item, { retagging, fresh, expanded = false, autofocusBody = false, handlers }) {
  const row = el('div', { className: 'task-row', dataset: { id: item.id } });
  if (item.focused) row.classList.add('focused');
  if (item.status === 'resolving') row.classList.add('resolving');
  if (item.status === 'done') row.classList.add('done');
  if (fresh) row.classList.add('fresh');
  if (expanded) row.classList.add('expanded');
  row.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    handlers.menu(e.clientX, e.clientY, item);
  });

  row.appendChild(expander(item, expanded, handlers));

  const text = el('span', {
    className: 'task-text',
    text: item.text,
    title: item.status === 'axis' ? 'Click to focus this thread' : item.text,
  });
  text.onclick = () => {
    if (item.status === 'axis') handlers.focus(item.id);
    else if (item.status === 'note') handlers.toggleExpand(item.id); // a note's title opens it
  };
  row.appendChild(text);
  // Rows still in the dump have no bar or core to light up, and neither has a note.
  if (item.status !== 'dump' && item.status !== 'note') {
    row.addEventListener('mouseenter', () => handlers.hover(item.id));
    row.addEventListener('mouseleave', () => handlers.hover(null));
  }

  if (item.status !== 'note') row.appendChild(tagControl(item, retagging, handlers));
  actionButtons(item, handlers).forEach((button) => row.appendChild(button));
  if (item.status === 'note') row.appendChild(noteMeta(item, expanded));

  if (expanded) {
    const editor = createBodyEditor(
      // A task mid-close can't be edited (the store refuses), so don't offer it.
      { item, readOnly: item.status === 'resolving', autofocus: autofocusBody },
      { save: (body) => handlers.saveBody(item.id, body) },
    );
    row.appendChild(editor.node);
  }
  return row;
}
