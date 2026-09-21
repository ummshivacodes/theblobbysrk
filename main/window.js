// The overlay window, and every rule about keeping it alive. Blob runs for days,
// so the window has to survive the ways a window can go missing:
//   - it gets destroyed: every call on a destroyed BrowserWindow throws "Object
//     has been destroyed", so everything goes through liveWindow() and a missing
//     window is rebuilt on demand;
//   - ⌘W: Electron's default menu gives every window "Close Window", so closing
//     only hides, and only a real quit lets it close;
//   - its renderer dies: reload it, but give up if it keeps dying.
// The Electron pieces come in through the factory, so this runs under test with fakes.

// The panel's initial size and its ceiling. The renderer asks for smaller sizes
// when it is collapsed to the orb row.
const MAX_WIDTH = 360;
const MAX_HEIGHT = 560;

const CRASH_WINDOW_MS = 60 * 1000;  // how far back a crash still counts
const MAX_RELOADS = 3;              // reloads allowed within that window

// isReady: is Electron ready to make windows? (default: yes). now / log: injected
// for tests; log defaults to the console.
function createWindowManager({
  BrowserWindow, screen, preloadPath, indexPath, debug = false, isReady = () => true, now = Date.now, log = console,
}) {
  let win = null;
  let quitting = false;   // set the moment a real quit starts; until then closing only hides
  let crashTimes = [];    // when the renderer died recently

  // Whatever is asked of the window (hotkey, tray, Dock, a second launch), a
  // destroyed one must never be called.
  const liveWindow = () => (win && !win.isDestroyed() ? win : null);

  // Nothing the page does may open another window or leave index.html. Links go
  // out through links.openExternal (main re-validates them); anything else is
  // refused. Registered before the page loads.
  function lockDown(w) {
    w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    w.webContents.on('will-navigate', (event) => event.preventDefault());
  }

  // If the renderer dies (crash, out of memory, killed) the window would sit
  // there blank for good. Everything is saved on every change, so reloading
  // loses nothing. Give up if it keeps dying, so a crash that happens on every
  // load can't spin forever.
  function reloadOnCrash(w) {
    w.webContents.on('render-process-gone', (e, details) => {
      if (quitting || details.reason === 'clean-exit') return;
      log.warn('[main] renderer gone:', details.reason);
      const t = now();
      crashTimes = crashTimes.filter((at) => t - at < CRASH_WINDOW_MS);
      crashTimes.push(t);
      if (crashTimes.length > MAX_RELOADS) {
        log.error('[main] renderer keeps dying; not reloading again');
        return;
      }
      if (!w.isDestroyed()) w.reload();
    });
  }

  function logDebug(w) {
    w.webContents.on('console-message', (ev) =>
      log.log(`[renderer:${ev.level}] ${ev.message} (${ev.sourceId}:${ev.lineNumber})`));
    w.webContents.on('did-finish-load', () => log.log('[main] did-finish-load', w.getBounds()));
    w.webContents.on('preload-error', (e, p, err) => log.log('[preload-error]', p, err));
    w.webContents.on('render-process-gone', (e, d) => log.log('[render-process-gone]', d));
  }

  // Builds the window, or returns the live one: there is only ever one.
  function create() {
    const existing = liveWindow();
    if (existing) return existing;

    const { width: sw } = screen.getPrimaryDisplay().workAreaSize;

    const w = new BrowserWindow({
      width: MAX_WIDTH,
      height: MAX_HEIGHT,
      x: sw - MAX_WIDTH - 24,
      y: 40,
      frame: false,
      transparent: true,
      alwaysOnTop: true,
      resizable: false,
      hasShadow: false, // the CSS draws its own shadows; the OS one would box the orbs
      backgroundColor: '#00000000',
      webPreferences: {
        preload: preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    win = w;

    lockDown(w);

    w.setAlwaysOnTop(true, 'floating');
    // skipTransformProcessType: without it Electron turns the process into a
    // UI-element app to float over full-screen windows, which removes the
    // Dock icon. We want the Dock icon; the tray + hotkey cover full-screen.
    w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
    // Absolute, so it doesn't depend on which script Electron was launched with
    // (the Electron tests launch their own script under test/app/ and require main.js).
    w.loadFile(indexPath);

    if (debug) logDebug(w);

    // Let the renderer know when the hotkey revealed / hid it so it can
    // open the panel with the input focused, or drop back to ambient.
    w.on('show', () => w.webContents.send('window-shown'));
    w.on('hide', () => w.webContents.send('window-hidden'));

    // Closing hides. Only a real quit (× button, tray Quit, ⌘Q) lets it close.
    w.on('close', (e) => {
      if (quitting) return;
      e.preventDefault();
      w.hide();
    });

    reloadOnCrash(w);
    return w;
  }

  function show() {
    if (quitting || !isReady()) return;  // mid-startup: the ready handler makes the window
    const w = create();
    w.show();
    w.focus();
  }

  function hide() {
    const w = liveWindow();
    if (w) w.hide();
  }

  function toggle() {
    const w = liveWindow();
    if (w && w.isVisible()) w.hide();
    else show();
  }

  // Click-through fix: the window rectangle is always exactly the visible
  // content. The renderer measures itself and asks for that size; we keep the
  // top-right corner where it is (so the orbs never jump on screen, and a drag
  // of the panel header is respected on the next resize).
  function resize(size) {
    const w = liveWindow();
    if (!w) return;
    const { width, height } = size || {};
    const asked = { w: Math.round(width), h: Math.round(height) };
    if (Number.isNaN(asked.w) || Number.isNaN(asked.h)) return;  // setBounds would throw on it
    const b = w.getBounds();
    const right = b.x + b.width;
    const nextW = Math.max(1, Math.min(MAX_WIDTH, asked.w));
    const nextH = Math.max(1, Math.min(MAX_HEIGHT, asked.h));
    w.setBounds({ x: Math.round(right - nextW), y: b.y, width: nextW, height: nextH }, false);
    if (debug) log.log('[resize] asked', { width, height }, '→ bounds', w.getBounds());
  }

  // Called when a real quit starts (Electron's before-quit): from here on the
  // window may close, a crash is not reloaded, and nothing is shown.
  function markQuitting() {
    quitting = true;
  }

  return { liveWindow, create, show, hide, toggle, resize, markQuitting };
}

module.exports = { createWindowManager };
