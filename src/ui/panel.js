// The panel's fold-out/fold-back animation and the window sizing that goes with it. The window is
// always resized to exactly the visible content (so clicks around the blob pass through to whatever is
// underneath), which is why opening grows the window first and closing shrinks it last.
//
// What else has to happen when the panel collapses (hide the tooltip, drop the hover, blur the input,
// go back to the main screen) is the caller's business: it passes onCollapse.
const LEAVE_GRACE_MS = 300;
const COLLAPSE_MS = 240;

export function createPanel({ shell, panel, windowCtl, onCollapse }) {
  let expanded = false;
  let animating = false;
  let leaveTimer = null;
  let collapseTimer = null;

  // Ask main to make the window exactly the size of the shell.
  function sendShellSize() {
    const r = shell.getBoundingClientRect();
    windowCtl.resize(Math.ceil(r.width), Math.ceil(r.height));
  }

  // Called after every render. Mid-animation the transition's end handler syncs instead.
  function syncSize() {
    if (animating) return;
    sendShellSize();
  }

  function open() {
    clearTimeout(leaveTimer);
    clearTimeout(collapseTimer);
    if (expanded) return;
    expanded = true;
    animating = true;

    // Measure the target: lay the panel out at its natural height, grow the window first (so nothing
    // is clipped mid-animation), then animate the height from 0.
    panel.style.transition = 'none';
    panel.style.display = 'block';
    panel.style.height = 'auto';
    const targetH = panel.offsetHeight;
    sendShellSize();
    panel.style.height = '0px';
    void panel.offsetHeight; // reflow
    panel.style.transition = '';
    requestAnimationFrame(() => {
      panel.style.height = `${targetH}px`;
      panel.classList.add('open');
      collapseTimer = setTimeout(() => { animating = false; }, COLLAPSE_MS);
    });
  }

  function close({ immediate = false } = {}) {
    clearTimeout(leaveTimer);
    clearTimeout(collapseTimer);
    if (!expanded) return;
    expanded = false;
    onCollapse();

    const finish = () => {
      panel.style.display = 'none';
      panel.style.height = '0px';
      animating = false;
      sendShellSize(); // shrink the window only after the panel is gone
    };

    if (immediate) {
      panel.style.transition = 'none';
      panel.classList.remove('open');
      finish();
      void panel.offsetHeight;
      panel.style.transition = '';
      return;
    }

    animating = true;
    panel.classList.remove('open');
    panel.style.height = '0px';
    collapseTimer = setTimeout(finish, COLLAPSE_MS);
  }

  function scheduleClose() {
    clearTimeout(leaveTimer);
    leaveTimer = setTimeout(() => close(), LEAVE_GRACE_MS);
  }

  // Hover anywhere on the shell (orbs or the open panel) keeps it open; leaving starts the grace
  // timer so going from the orbs to the panel doesn't collapse it.
  shell.addEventListener('mouseenter', open);
  shell.addEventListener('mouseleave', scheduleClose);

  return { open, close, syncSize };
}
