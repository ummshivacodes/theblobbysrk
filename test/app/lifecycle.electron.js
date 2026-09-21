// Electron-level lifecycle test for main.js. Blob is an overlay that runs for days, so the window
// it lives in has to survive the ways a window can disappear, and still quit when told to:
//   ⌘W (Electron's default menu closes the window), the window being destroyed outright,
//   the renderer being killed, and a renderer that dies on every load.
//
//   npm run test:app
//
// Needs a GUI session: it briefly shows a Blob window, a tray icon and a Dock icon (~20 s), so don't
// type while it runs. Isolated by construction (see scripts/lib/isolatedApp.js): fixture data and its
// own profile, never your real threads.json, so it is safe to run while Blob itself is running.
const { bootIsolatedApp } = require('../../scripts/lib/isolatedApp.js');
const { sleep, waitFor, createReporter } = require('./harness.js');

const ctx = bootIsolatedApp({
  fixture: {
    threads: [{ id: 'fixture1', text: 'fixture thread', quad: 1, status: 'axis', createdAt: 1 }],
    stats: { listed: 1, done: 0 },
    history: [],
  },
});
const { app, BrowserWindow } = ctx;
const { check, finish } = createReporter({ app, cleanup: ctx.cleanup });

const windows = () => BrowserWindow.getAllWindows();

// "Working" = the page finished its first render (the renderer flags that with <html data-ready="1">).
const rendererUp = async (w) => {
  if (!w || w.isDestroyed()) return false;
  try {
    return await Promise.race([
      w.webContents.executeJavaScript('document.documentElement.dataset.ready === "1"'),
      sleep(2000).then(() => false),
    ]);
  } catch {
    return false;
  }
};

// What a Dock click does; the hotkey, the tray and a second launch all funnel into the same place.
const dockClick = () => {
  try { app.emit('activate'); return null; } catch (e) { return e.message; }
};

// Kill the renderer and resolve once main has seen it die (forcefullyCrashRenderer is async).
const crash = (w) => new Promise((resolve) => {
  w.webContents.once('render-process-gone', (e, d) => resolve(d.reason));
  w.webContents.forcefullyCrashRenderer();
});

app.whenReady().then(async () => {
  check('boots with one window and a working renderer',
    await waitFor(() => windows().length === 1 && rendererUp(windows()[0]), 10000));
  let w = windows()[0];

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
  check('…with a working renderer', await waitFor(() => rendererUp(w), 8000));

  // The renderer being killed (crash, memory pressure, …).
  const pidBefore = w.webContents.getOSProcessId();
  await crash(w);
  const recovered = await waitFor(() => rendererUp(w), 8000);
  check('a killed renderer is reloaded automatically', recovered);
  check('…as a fresh process', recovered && w.webContents.getOSProcessId() !== pidBefore);

  // A renderer that dies on every load must not reload forever: 3 reloads a minute, then give up.
  const recoveries = [];
  for (let i = 0; i < 2; i++) {
    await crash(w);
    recoveries.push(await waitFor(() => rendererUp(w), 8000));
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
