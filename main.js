// Composition root of the main process: builds each part, hands it what it needs,
// and listens for the app-level events. No logic lives here; the parts are in
// main/ and know nothing of each other. Besides preload.js, this is the only file
// that touches Electron directly.
const { app, BrowserWindow, globalShortcut, ipcMain, net, screen, shell, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const { createPersistence } = require('./main/persistence');
const { createLinks } = require('./main/links');
const { createWindowManager } = require('./main/window');
const { createTray, formatHotkey } = require('./main/tray');
const { createSettings } = require('./main/settings');
const { registerIpc } = require('./main/ipc');

// Change this if it clashes with something else on your Mac.
const HOTKEY = 'CommandOrControl+Shift+Y';

const windows = createWindowManager({
  BrowserWindow,
  screen,
  preloadPath: path.join(__dirname, 'preload.js'),
  indexPath: path.join(__dirname, 'index.html'),
  debug: process.env.THREAD_AXIS_DEBUG === '1',
  isReady: () => app.isReady(),
});

let tray; // kept on purpose: a Tray nothing points at is garbage-collected and its icon vanishes

// One Blob at a time: launching it again just reveals the running one.
if (!app.requestSingleInstanceLock()) {
  app.quit();
}
app.on('second-instance', () => windows.show());

app.whenReady().then(() => {
  // Pinned to the original folder so the packaged "Blob" app and `npm start`
  // read the same file. (userData would otherwise follow the product name.)
  // THREAD_AXIS_DATA=/some/file.json overrides it, so tests can run against a
  // scratch copy instead of your real tasks. Worked out once, here.
  const persistence = createPersistence({
    filePath: process.env.THREAD_AXIS_DATA || path.join(app.getPath('appData'), 'thread-axis', 'threads.json'),
    // A file that parses but has no threads array would be ignored by the page,
    // which would start empty, and the next save would overwrite it. So it
    // counts as unreadable: set aside, and the backup is used instead.
    validate: (data) => Array.isArray(data.threads),
  });
  const links = createLinks({ shell, fetch: (url, init) => net.fetch(url, init) });
  registerIpc({ ipcMain, persistence, links, windows, app, settings: createSettings({ app }) });

  windows.create();
  tray = createTray({
    Tray,
    Menu,
    nativeImage,
    iconPath: path.join(__dirname, 'assets', 'blobTemplate.png'),
    hotkeyLabel: formatHotkey(HOTKEY),
    onShow: () => windows.show(),
    onHide: () => windows.hide(),
    onToggle: () => windows.toggle(),
    onQuit: () => app.quit(),
  });

  const ok = globalShortcut.register(HOTKEY, () => windows.toggle());

  if (!ok) {
    console.warn('Hotkey registration failed — it may already be taken by another app.');
  }
});

// Fires first on every real quit (× button, tray Quit, ⌘Q, logout), which is
// what lets the window's close handler stop hiding and actually close.
app.on('before-quit', () => windows.markQuitting());

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

// Closing only hides (see main/window.js), so this fires only while quitting.
// Registered anyway so Electron never decides to quit on its own.
app.on('window-all-closed', () => {});

// Clicking the Dock icon brings the blob back.
app.on('activate', () => windows.show());
