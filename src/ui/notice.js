// The notice bar: a one-line-or-two message across the top of the panel, for the few things the person must
// not miss and cannot act on from where they are (Blob restored a backup at startup; a change could not be
// saved). Notices have ids so that a cause that goes away can take its own notice with it (a later save
// succeeds: "couldn't save" is no longer true). The newest is shown; × dismisses it, revealing an older one.

export const SAVE_FAILED = 'Couldn’t save your last change. It stays on screen and Blob will try again with your next change.';
export const RECOVERED = 'Your saved file was damaged, so Blob restored its last backup. Nothing was overwritten: the damaged file was kept next to it.';

// What the main process reported about loading, as a message to show, or null for nothing worth saying.
// (main/ipc.js: null, or { kind: 'recovered-from-backup', at }.) An unknown kind is ignored on purpose: a newer
// main process must not make an older page show something it cannot explain.
export function describeLoadNotice(notice) {
  if (notice && notice.kind === 'recovered-from-backup') return RECOVERED;
  return null;
}

// els = { bar, text, close }
export function createNotice({ bar, text, close }) {
  const messages = new Map(); // id → message, in the order they arrived

  function draw() {
    const latest = [...messages.values()].pop();
    bar.hidden = latest === undefined;
    text.textContent = latest === undefined ? '' : latest;
  }

  close.addEventListener('click', () => {
    const latest = [...messages.keys()].pop();
    if (latest !== undefined) messages.delete(latest);
    draw();
  });

  return {
    // A message under an id. Showing the same id again replaces it and brings it to the front.
    show(id, message) {
      messages.delete(id);
      messages.set(id, message);
      draw();
    },
    clear(id) {
      messages.delete(id);
      draw();
    },
  };
}
