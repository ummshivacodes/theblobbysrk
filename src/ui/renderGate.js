// Holds a redraw back while the user is in the middle of something, then draws once when they are done.
//
// The page redraws everything from scratch on every change. That is fine until a change lands mid-gesture:
//   - a note being typed into a textarea would be destroyed, and the sentence with it;
//   - a click is only delivered when the element under the pointer at mouse-down is still the one at
//     mouse-up. Saving an edit on blur happens exactly between the two, so a redraw right then would
//     swallow the click that caused the blur.
// The gate is the one place that knows this. It knows nothing about the DOM: whoever builds it says what
// "held" means (isHeld) and what drawing is (draw), so it runs (and is tested) in plain Node.
//
//   request()  a redraw is wanted. It happens now, unless something is holding it: then it is remembered.
//   release()  call whenever a hold may have ended. Draws the remembered redraw if nothing holds it now.
//
// Many requests while held collapse into a single draw, of whatever the state is by then.
export function createRenderGate({ draw, isHeld }) {
  let wanted = false;

  return {
    request() {
      if (isHeld()) {
        wanted = true;
        return;
      }
      wanted = false;
      draw();
    },
    release() {
      if (!wanted || isHeld()) return;
      wanted = false;
      draw();
    },
    // Is a redraw waiting? (For tests and diagnostics.)
    pending: () => wanted,
  };
}
