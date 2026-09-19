// Electron-level lifecycle test for main.js. Blob is an overlay that runs for days, so the
// window it lives in has to survive the ways a window can disappear, and still quit when told to:
//   ⌘W (Electron's default menu closes the window), the window being destroyed outright,
//   the renderer being killed, and a renderer that dies on every load.
//
//   npm run test:app
//
// Needs a GUI session: it briefly shows a Blob window, a tray icon and a Dock icon (~20 s), so
// don't type while it runs. Isolated by construction: fixture data in a temp dir and its own
// userData (which is also where the single-instance lock lives), so it never reads or writes
// your real threads.json and is safe to run while Blob itself is running.
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'blob-lifecycle-'));
fs.mkdirSync(path.join(tmp, 'profile'));
app.setPath('userData', path.join(tmp, 'profile'));
process.env.THREAD_AXIS_DATA = path.join(tmp, 'threads.json');
fs.writeFileSync(process.env.THREAD_AXIS_DATA, JSON.stringify({
  threads: [{ id: 'fixture1', text: 'fixture thread', quad: 1, status: 'axis', createdAt: 1 }],
  stats: { listed: 1, done: 0 },
  history: [],
}));

require('../main.js');

let failed = 0;
const check = (name, ok, extra = '') => {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 4000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await fn()) return true;
    await sleep(100);
  }
  return false;
};
// "Working" = the page loaded and renderer.js ran (it defines the top-level `store`).
const rendererUp = async (w) => {
  if (!w || w.isDestroyed()) return false;
  try {
    return await Promise.race([
      w.webContents.executeJavaScript('!!document.getElementById("shell") && typeof store === "object"'),
      sleep(2000).then(() => false),
    ]);
  } catch {
    return false;
  }
};
const windows = () => BrowserWindow.getAllWindows();
// What a Dock click does; the hotkey, the tray and a second launch all funnel into the same place.
const dockClick = () => {
  try { app.emit('activate'); return null; } catch (e) { return e.message; }
};
// Kill the renderer and resolve once main has seen it die (forcefullyCrashRenderer is async).
const crash = (w) => new Promise((resolve) => {
  w.webContents.once('render-process-gone', (e, d) => resolve(d.reason));
  w.webContents.forcefullyCrashRenderer();
});

function finish() {
  console.log(failed ? `\nRESULT: ${failed} check(s) FAILED` : '\nRESULT: all lifecycle checks passed');
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* temp dir; the OS clears it */ }
  app.exit(failed ? 1 : 0);
}

setTimeout(() => { check('finished within the watchdog time', false); finish(); }, 90 * 1000);

app.whenReady().then(async () => {
  await sleep(1500);
  let w = windows()[0];
  check('boots with one window and a working renderer', windows().length === 1 && await rendererUp(w));

  // ⌘W is "Close Window" in Electron's default menu.
  w.close();
  await sleep(400);
  check('⌘W hides the window instead of destroying it', !w.isDestroyed() && !w.isVisible());
  check('…and its renderer keeps running', await rendererUp(w));
  let threw = dockClick();
  await sleep(400);
  check('a Dock click brings it back', threw === null && w.isVisible(), threw || '');

  // Launching Blob a second time just reveals the running one.
  w.hide();
  app.emit('second-instance');
  await sleep(400);
  check('launching Blob again reveals it', w.isVisible());

  // The worst case: something really destroys the window (destroy() skips the close handler).
  w.destroy();
  await sleep(400);
  check('(precondition) destroy() leaves no window', windows().length === 0);
  threw = dockClick();
  const healed = await waitFor(() => windows().length === 1);
  w = windows()[0];
  check('a Dock click rebuilds a destroyed window', threw === null && healed && w.isVisible(), threw || '');
  check('…with a working renderer', await waitFor(() => rendererUp(w), 5000));

  // The renderer being killed (crash, memory pressure, …).
  const pidBefore = w.webContents.getOSProcessId();
  await crash(w);
  const recovered = await waitFor(() => rendererUp(w), 6000);
  check('a killed renderer is reloaded automatically', recovered);
  check('…as a fresh process', recovered && w.webContents.getOSProcessId() !== pidBefore);

  // A renderer that dies on every load must not reload forever: 3 reloads a minute, then give up.
  const recoveries = [];
  for (let i = 0; i < 2; i++) {
    await crash(w);
    recoveries.push(await waitFor(() => rendererUp(w), 6000));
  }
  await crash(w);
  await sleep(2500);
  check('a crash loop is bounded (reloads, then gives up)', recoveries.every(Boolean) && !(await rendererUp(w)));

  // A real quit must still work with hide-on-close in place.
  app.once('will-quit', () => {
    check('a real quit is not blocked by hide-on-close', true);
    finish();
  });
  setTimeout(() => {
    check('a real quit is not blocked by hide-on-close', false, 'will-quit never fired');
    finish();
  }, 6000);
  app.quit();
}).catch((e) => {
  // An unexpected throw (e.g. a call on a destroyed window) is a failure, not a hang.
  check('lifecycle run aborted', false, e.message);
  finish();
});
