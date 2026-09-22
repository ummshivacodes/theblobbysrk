// A pointer-based drag-to-reorder controller for a vertical list of rows. Knows nothing about tasks,
// notes or the store: it moves `.task-row` elements around inside a container and, when the user lets go
// somewhere different from where they picked up, reports the container's new full order of ids. Whoever
// wires it in decides what happens with that order (see ui/app.js).
//
// Deliberately not the browser's native Drag and Drop API (`draggable`, `dragstart`/`dragover`/`drop`):
// that hands you a browser-drawn ghost image that is fiddly to suppress or restyle, and it is a second,
// separate event model alongside the pointerdown/pointermove/pointerup one the render gate, the press
// guard and every editor in this app already speak. Built on plain pointer events instead, it plugs
// straight into what is already there.
//
// A row's drag handle is any element inside it carrying the class `drag-handle`; the row itself is the
// nearest ancestor with a `data-id` (every row in this app already has one, from ui/dom.js's `el()`).
//
//   createDragList({ container, onReorder(orderedIds) }) -> { isDragging(), destroy() }
//
// Esc cancels a drag in progress: the row goes back exactly where it started, and onReorder is not
// called. Letting go anywhere else — even back at the start — calls onReorder only if the order actually
// changed (dropping something back where it was is not a move).
export function createDragList({ container, onReorder }) {
  let drag = null; // { row, pointerId, startIndex } while a drag is in progress

  const rows = () => [...container.children].filter((el) => el.classList.contains('task-row'));
  const idsOf = (list) => list.map((row) => row.dataset.id);

  // Where the dragged row belongs right now: the pointer's Y against every OTHER row's vertical
  // midpoint, recomputed fresh each time (not an incremental swap), so a single fast movement lands in
  // the right place in one step instead of lagging a step behind the cursor.
  function targetRef(pointerY) {
    const siblings = rows().filter((row) => row !== drag.row);
    const below = siblings.find((row) => {
      const box = row.getBoundingClientRect();
      return pointerY < box.top + box.height / 2;
    });
    return below || null; // null: belongs at the end (insertBefore(row, null) appends)
  }

  function onPointerDown(e) {
    if (e.button !== 0 || drag) return;
    const handle = e.target.closest('.drag-handle');
    if (!handle) return;
    const row = handle.closest('.task-row');
    if (!row) return;
    e.preventDefault(); // this is a drag, not a text selection, a focus change or a native button press
    handle.setPointerCapture(e.pointerId);
    drag = { row, pointerId: e.pointerId, startIndex: rows().indexOf(row) };
    row.classList.add('dragging');
  }

  function onPointerMove(e) {
    if (!drag || e.pointerId !== drag.pointerId) return;
    const ref = targetRef(e.clientY);
    if (drag.row.nextSibling !== ref) container.insertBefore(drag.row, ref);
  }

  // commit: false for Esc/pointercancel — put the row back where it started, call nothing.
  function finish(commit) {
    const { row, startIndex } = drag;
    row.classList.remove('dragging');
    if (commit) {
      const finalIndex = rows().indexOf(row);
      if (finalIndex !== startIndex) onReorder(idsOf(rows()));
    } else {
      const without = rows().filter((r) => r !== row);
      container.insertBefore(row, without[startIndex] || null);
    }
    drag = null;
  }

  function onPointerUp(e) {
    if (!drag || e.pointerId !== drag.pointerId) return;
    finish(true);
  }
  function onPointerCancel(e) {
    if (!drag || e.pointerId !== drag.pointerId) return;
    finish(false);
  }
  function onKeyDown(e) {
    if (!drag || e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation(); // this Esc ends the drag; it must not also close the panel or leave the screen
    finish(false);
  }

  container.addEventListener('pointerdown', onPointerDown);
  document.addEventListener('pointermove', onPointerMove);
  document.addEventListener('pointerup', onPointerUp);
  document.addEventListener('pointercancel', onPointerCancel);
  document.addEventListener('keydown', onKeyDown, true);

  return {
    isDragging: () => !!drag,
    destroy() {
      container.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('pointermove', onPointerMove);
      document.removeEventListener('pointerup', onPointerUp);
      document.removeEventListener('pointercancel', onPointerCancel);
      document.removeEventListener('keydown', onKeyDown, true);
    },
  };
}
