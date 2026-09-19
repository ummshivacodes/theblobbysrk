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
const dataPath = () => path.join(app.getPath('appData'), 'thread-axis', 'threads.json');

let win;
let tray;

function showWindow() {
  if (!win) return;
  win.show();
  win.focus();
}

function toggleWindow() {
  if (!win) return;
  if (win.isVisible()) win.hide();
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
  win.loadFile('index.html');

  if (DEBUG) {
    win.webContents.on('console-message', (ev) =>
      console.log(`[renderer:${ev.level}] ${ev.message} (${ev.sourceId}:${ev.lineNumber})`));
    win.webContents.on('did-finish-load', () => console.log('[main] did-finish-load', win.getBounds()));
    win.webContents.on('preload-error', (e, p, err) => console.log('[preload-error]', p, err));
    win.webContents.on('render-process-gone', (e, d) => console.log('[render-process-gone]', d));
  }

  // THREAD_AXIS_SELFTEST=1: drive expand → add task → collapse from here so the
  // sizing path can be checked from a terminal without a mouse.
  if (process.env.THREAD_AXIS_SELFTEST === '1') {
    const run = (js) => win.webContents.executeJavaScript(js).catch((e) => console.log('[selftest error]', e.message));
    const log = (tag) => console.log(`[selftest] ${tag}`, win.getBounds());
    win.webContents.once('did-finish-load', () => {
      setTimeout(() => { log('collapsed'); run('window.__statsBefore = JSON.stringify(state.stats); openPanel()'); }, 800);
      setTimeout(() => { log('expanded'); run("store.addTask('selftest thread'); store.tagTask(state.threads.at(-1).id, 1); store.dispatchToAxis(state.threads.at(-1).id); store.toggleFocus(state.threads.at(-1).id)"); }, 1600);
      setTimeout(() => { run("(() => { const id = 'selftest-recall'; state.threads.push({id, text: 'recall check', quad: 2, status: 'dump', createdAt: Date.now()}); store.dispatchToAxis(id); const onAxis = state.threads.find(x => x.id === id).status; store.recallToDump(id); const backInDump = state.threads.find(x => x.id === id).status; store.deleteTask(id); console.log('[selftest-status] push/recall:', onAxis, '->', backInDump); })()"); }, 1700);
      setTimeout(() => { log('expanded+task'); run("store.resolveThread(state.threads.at(-1).id)"); }, 2400);
      setTimeout(() => { run("console.log('[selftest-status] after resolve:', state.threads.at(-1).status, '| bars in svg:', document.querySelectorAll('#axisSvg g.bar-g').length, '| done rows:', document.querySelectorAll('.task-row.done').length, '| undo btns:', document.querySelectorAll('.task-act.undo').length, '| history:', state.history.length, '| done stat:', state.stats.done)"); }, 3400);
      setTimeout(() => { run("showScreen('done'); console.log('[selftest-status] gear screen:', document.getElementById('doneScreen').classList.contains('active'), '| history rows:', document.querySelectorAll('#doneList .task-row').length, '| big:', document.getElementById('doneBig').textContent)"); }, 3500);
      setTimeout(() => { run("showScreen('main'); store.reopenTask(state.threads.at(-1).id); console.log('[selftest-status] after reopen:', state.threads.at(-1).status, '| strike lines:', document.querySelectorAll('#axisSvg g.bar-g .strike').length, '| history:', state.history.length, '| done stat:', state.stats.done, '| main screen:', document.getElementById('mainScreen').classList.contains('active'))"); }, 3600);
      setTimeout(() => { run("store.resolveThread(state.threads.at(-1).id)"); }, 3650);
      setTimeout(() => { run("store.deleteTask(state.threads.at(-1).id); state.stats = JSON.parse(window.__statsBefore); state.history = state.history.filter(h => h.text !== 'selftest thread'); store.persist(); render(); console.log('[selftest-status] after delete: threads', state.threads.length, '| bars', document.querySelectorAll('#axisSvg g.bar-g').length)"); run('closePanel()'); }, 4500);
      setTimeout(() => { log('collapsed, cleaned'); app.quit(); }, 5200);
    });
  }

  // THREAD_AXIS_SHOT=/path.png [THREAD_AXIS_EVAL="js"]: run some JS in the
  // renderer, capture the window to a PNG, quit. For eyeballing a screen
  // from a terminal without touching the mouse.
  if (process.env.THREAD_AXIS_SHOT) {
    win.webContents.once('did-finish-load', () => {
      setTimeout(() => win.webContents.executeJavaScript(process.env.THREAD_AXIS_EVAL || 'openPanel()').catch((e) => console.log('[shot eval error]', e.message)), 600);
      setTimeout(async () => {
        const img = await win.webContents.capturePage();
        fs.writeFileSync(process.env.THREAD_AXIS_SHOT, img.toPNG());
        console.log('[shot] wrote', process.env.THREAD_AXIS_SHOT, win.getBounds());
        app.quit();
      }, 1600);
    });
  }

  // Let the renderer know when the hotkey revealed / hid it so it can
  // open the panel with the input focused, or drop back to ambient.
  win.on('show', () => win.webContents.send('window-shown'));
  win.on('hide', () => win.webContents.send('window-hidden'));
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
    { label: 'Hide Blob', click: () => win && win.hide() },
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

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

// Frameless window has no OS close button, and hide() never fires this anyway.
// Kept so the app behaves if you ever add one back.
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
  if (!win) return;
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
ipcMain.on('hide-window', () => win && win.hide());
