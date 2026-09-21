const { app, BrowserWindow, globalShortcut, ipcMain, screen, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');

// Change this if it clashes with something else on your Mac.
const HOTKEY = 'CommandOrControl+Shift+Y';

// Widest the panel ever gets. The renderer asks for smaller sizes when
// collapsed to the orb row; this is just the initial/maximum.
const MAX_WIDTH = 360;
const MAX_HEIGHT = 560;
const DEBUG = process.env.THREAD_AXIS_DEBUG === '1';

// Pinned to the original folder so the packaged "Blob" app and `npm start`
// read the same file. (userData would otherwise follow the product name.)
// THREAD_AXIS_DATA=/some/file.json overrides it, so tests can run against a
// scratch copy instead of your real tasks.
const dataPath = () => process.env.THREAD_AXIS_DATA
  || path.join(app.getPath('appData'), 'thread-axis', 'threads.json');

let win;
let tray;
let quitting = false;   // set the moment a real quit starts; until then closing only hides
let crashTimes = [];    // when the renderer died recently (see render-process-gone below)

// The overlay is meant to live for the whole session, but never assume it
// does: every call on a destroyed BrowserWindow throws "Object has been
// destroyed", and the hotkey, tray, Dock and second-launch handlers all come
// through here. Whatever is asked, a missing window is rebuilt first.
const liveWindow = () => (win && !win.isDestroyed() ? win : null);

function showWindow() {
  if (quitting || !app.isReady()) return;  // mid-startup: the ready handler makes the window
  if (!liveWindow()) createWindow();
  win.show();
  win.focus();
}

function hideWindow() {
  const w = liveWindow();
  if (w) w.hide();
}

function toggleWindow() {
  const w = liveWindow();
  if (w && w.isVisible()) w.hide();
  else showWindow();
}

function createWindow() {
  const { width: sw } = screen.getPrimaryDisplay().workAreaSize;

  win = new BrowserWindow({
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
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.setAlwaysOnTop(true, 'floating');
  // skipTransformProcessType: without it Electron turns the process into a
  // UI-element app to float over full-screen windows, which removes the
  // Dock icon. We want the Dock icon; the tray + hotkey cover full-screen.
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
  // Absolute, so it doesn't depend on which script Electron was launched with
  // (the Electron tests launch their own script under test/app/ and require this file).
  win.loadFile(path.join(__dirname, 'index.html'));

  if (DEBUG) {
    win.webContents.on('console-message', (ev) =>
      console.log(`[renderer:${ev.level}] ${ev.message} (${ev.sourceId}:${ev.lineNumber})`));
    win.webContents.on('did-finish-load', () => console.log('[main] did-finish-load', win.getBounds()));
    win.webContents.on('preload-error', (e, p, err) => console.log('[preload-error]', p, err));
    win.webContents.on('render-process-gone', (e, d) => console.log('[render-process-gone]', d));
  }

  // Let the renderer know when the hotkey revealed / hid it so it can
  // open the panel with the input focused, or drop back to ambient.
  win.on('show', () => win.webContents.send('window-shown'));
  win.on('hide', () => win.webContents.send('window-hidden'));

  // Closing hides. Electron's default app menu gives every window ⌘W ("Close
  // Window"), and a destroyed window can't be brought back by the hotkey, the
  // tray or the Dock. Only a real quit (× button, tray Quit, ⌘Q) lets it close.
  win.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    win.hide();
  });

  // If the renderer dies (crash, out of memory, killed) the window would sit
  // there blank for good. Everything is saved on every change, so reloading
  // loses nothing. Give up if it keeps dying, so a crash that happens on every
  // load can't spin forever.
  win.webContents.on('render-process-gone', (e, details) => {
    if (quitting || details.reason === 'clean-exit') return;
    console.warn('[main] renderer gone:', details.reason);
    const now = Date.now();
    crashTimes = crashTimes.filter((t) => now - t < 60 * 1000);
    crashTimes.push(now);
    if (crashTimes.length > 3) {
      console.error('[main] renderer keeps dying; not reloading again');
      return;
    }
    if (!win.isDestroyed()) win.reload();
  });
}

// One Blob at a time: launching it again just reveals the running one.
if (!app.requestSingleInstanceLock()) {
  app.quit();
}
app.on('second-instance', showWindow);

function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'blobTemplate.png'));
  icon.setTemplateImage(true);
  tray = new Tray(icon);
  tray.setToolTip('Blob');
  const menu = Menu.buildFromTemplate([
    { label: 'Show Blob', click: showWindow },
    { label: 'Hide Blob', click: hideWindow },
    { type: 'separator' },
    { label: `Toggle: ${HOTKEY.replace('CommandOrControl', '⌘').replace('Shift', '⇧').replace(/\+/g, '')}`, enabled: false },
    { type: 'separator' },
    { label: 'Quit Blob', click: () => app.quit() },
  ]);
  tray.on('click', toggleWindow);          // left-click toggles
  tray.on('right-click', () => tray.popUpContextMenu(menu));
}

app.whenReady().then(() => {
  createWindow();
  createTray();

  const ok = globalShortcut.register(HOTKEY, toggleWindow);

  if (!ok) {
    console.warn('Hotkey registration failed — it may already be taken by another app.');
  }
});

// Fires first on every real quit (× button, tray Quit, ⌘Q, logout), which is
// what lets the window's close handler stop hiding and actually close.
app.on('before-quit', () => { quitting = true; });

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

// Closing only hides (see the close handler), so this fires only while
// quitting. Registered anyway so Electron never decides to quit on its own.
app.on('window-all-closed', () => {});

// Clicking the Dock icon brings the blob back.
app.on('activate', showWindow);

ipcMain.handle('load-threads', () => {
  try {
    return JSON.parse(fs.readFileSync(dataPath(), 'utf-8'));
  } catch {
    return null;
  }
});

ipcMain.handle('save-threads', (event, data) => {
  fs.writeFileSync(dataPath(), JSON.stringify(data, null, 2));
  return true;
});

// Click-through fix: the window rectangle is always exactly the visible
// content. The renderer measures itself and asks for that size; we keep
// the top-right corner where it is (so the orbs never jump on screen,
// and a drag of the panel header is respected on the next resize).
ipcMain.on('resize-window', (event, { width, height }) => {
  if (!liveWindow()) return;
  const b = win.getBounds();
  const right = b.x + b.width;
  const w = Math.max(1, Math.min(MAX_WIDTH, Math.round(width)));
  const h = Math.max(1, Math.min(MAX_HEIGHT, Math.round(height)));
  const next = { x: Math.round(right - w), y: b.y, width: w, height: h };
  win.setBounds(next, false);
  if (DEBUG) console.log('[resize] asked', { width, height }, '→ bounds', win.getBounds());
});

// Settings screen: launch at login. Returns the real state after the change
// so the toggle never lies if macOS refused it.
ipcMain.handle('get-login-item', () => app.getLoginItemSettings().openAtLogin);
ipcMain.handle('set-login-item', (event, on) => {
  try { app.setLoginItemSettings({ openAtLogin: !!on }); } catch (e) { console.warn('[login-item]', e.message); }
  return app.getLoginItemSettings().openAtLogin;
});

ipcMain.on('quit-app', () => app.quit());
ipcMain.on('hide-window', hideWindow);
