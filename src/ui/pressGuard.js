// While a body is being edited, pressing a button (or anything that isn't a text field) must not pull
// focus out of the editor on the mouse-DOWN.
//
// Why: an editor closes the moment it loses focus, and a closed editor is shorter than an open one. So
// if the press took focus, everything below the editor would jump up between mouse-down and mouse-up,
// the mouse-up would land on something else, and the browser would deliver no click at all. You would
// type a note, click ✓ on the row below it, and nothing would happen.
//
// So the press leaves focus where it is (preventDefault on mouse-down keeps the caret and the editor),
// and the edit ends only after the click has completed: the control's own handler runs first, on the
// element that was actually pressed, exactly where it was pressed, and then the editor lets go. (If the
// pressed thing is another editor, its handler moves focus there itself, and there is nothing left
// for this to do.)
//
//   root       an element that contains everything clickable (the shell)
//   isEditing  () => boolean: is a body editor holding focus right now?
//
// A press inside a text field is left alone (moving the caret, selecting, or going to another box).
export function installPressGuard({ root, isEditing }) {
  let kept = null; // the editor a press in flight was kept away from

  root.addEventListener('mousedown', (e) => {
    kept = null;
    if (e.button !== 0 || !isEditing()) return;
    if (e.target.closest('textarea, input')) return;
    e.preventDefault();
    kept = document.activeElement;
  }, true);

  // Capture phase, so it sees clicks whose handlers stop them from bubbling.
  root.addEventListener('click', () => {
    const editor = kept;
    kept = null;
    if (!editor) return;
    // After the control's own handler, and whatever that set in motion, has run. If focus has moved on
    // by then (to another editor), the first one has already ended and there is nothing to do.
    setTimeout(() => { if (document.activeElement === editor) editor.blur(); }, 0);
  }, true);
}
