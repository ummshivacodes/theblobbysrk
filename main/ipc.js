// The one place IPC channels are registered. Every channel is a literal call, so
// the names can be read straight from this file (the architecture test compares
// them with preload.js). A handler only forwards to the service that does the
// work; the one thing remembered here is the load notice.
//
//   page -> main, invoke:  load-threads  save-threads  get-login-item  set-login-item
//                          open-external  fetch-title  get-load-notice
//   page -> main, send:    resize-window  quit-app  hide-window
//   main -> page:          window-shown  window-hidden   (sent by main/window.js)

// `now` is injected for tests.
function registerIpc({ ipcMain, persistence, links, windows, app, settings, now = Date.now }) {
  // persistence.load() is not repeatable: after a recovery, a second call comes
  // back clean. The page asks for the notice separately, and maybe after a
  // reload, so the recovery is remembered here. The data is NOT cached: every
  // load-threads reads the file, as it always has, so a page that reloads after
  // a crash gets what was last saved, not what was there at launch.
  let notice = null;

  ipcMain.handle('load-threads', () => {
    const loaded = persistence.load();
    if (loaded.recoveredFrom === 'backup' && !notice) {
      notice = { kind: 'recovered-from-backup', at: now() };
    }
    return loaded.data;
  });

  ipcMain.handle('save-threads', (event, data) => {
    persistence.save(data);
    return true;
  });

  ipcMain.on('resize-window', (event, size) => windows.resize(size));

  // Settings screen: launch at login.
  ipcMain.handle('get-login-item', () => settings.getLoginItem());
  ipcMain.handle('set-login-item', (event, on) => settings.setLoginItem(on));

  ipcMain.on('quit-app', () => app.quit());
  ipcMain.on('hide-window', () => windows.hide());

  // The main process never trusts the page: links re-validates every URL.
  ipcMain.handle('open-external', (event, url) => links.openExternal(url));
  ipcMain.handle('fetch-title', (event, url) => links.fetchTitle(url));

  // null, or { kind: 'recovered-from-backup', at: <epoch ms> } once a load had to recover.
  ipcMain.handle('get-load-notice', () => notice);
}

module.exports = { registerIpc };
