// Screenshot helper: boots the real app on SAMPLE data, optionally runs some JS in the page, writes a
// PNG of the window and quits. For eyeballing the UI from a terminal without touching the mouse.
//
//   npx electron scripts/shot.electron.js out.png
//   npx electron scripts/shot.electron.js out.png "document.getElementById('gearBtn').click()"
//
// The default page script hovers the blob so the panel unfolds. To see your own tasks, point
//   BLOB_SHOT_DATA=/path/to/a/COPY/of/threads.json
// at a copy: it is read, and only ever written into a temp dir (see scripts/lib/isolatedApp.js), so
// your real threads.json is never opened for writing and Blob can keep running.
const fs = require('fs');
const path = require('path');
const { bootIsolatedApp } = require('./lib/isolatedApp.js');

const out = process.argv[2];
if (!out) {
  console.error('usage: npx electron scripts/shot.electron.js out.png ["js to run in the page first"]');
  process.exit(2);
}
const pageJs = process.argv[3]
  || 'document.getElementById("shell").dispatchEvent(new MouseEvent("mouseenter"))';

const T = 1700000000000;
const sample = {
  threads: [
    { id: 's1', text: 'Draft the launch email', quad: 1, status: 'axis', createdAt: T + 1 },
    { id: 's2', text: 'Review ad creatives', quad: 2, status: 'axis', createdAt: T + 2 },
    { id: 's3', text: 'Reorder packaging', quad: 3, status: 'dump', createdAt: T + 3 },
    { id: 's4', text: 'A thought to sort later', quad: null, status: 'dump', createdAt: T + 4 },
    { id: 's5', text: 'Finished thing', quad: 2, status: 'done', createdAt: T + 5, doneAt: T + 6 },
  ],
  stats: { listed: 5, done: 1 },
  history: [{ id: 's5', text: 'Finished thing', quad: 2, createdAt: T + 5, doneAt: T + 6 }],
};
const fixture = process.env.BLOB_SHOT_DATA
  ? JSON.parse(fs.readFileSync(process.env.BLOB_SHOT_DATA, 'utf8'))
  : sample;

const ctx = bootIsolatedApp({ fixture });
const { app, BrowserWindow } = ctx;

app.whenReady().then(async () => {
  const win = BrowserWindow.getAllWindows()[0];
  if (win.webContents.isLoading()) await new Promise((r) => win.webContents.once('did-finish-load', r));
  // The page flags itself ready once the saved state is drawn.
  for (let i = 0; i < 100; i++) {
    if (await win.webContents.executeJavaScript('document.documentElement.dataset.ready === "1"')) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  await win.webContents.executeJavaScript(pageJs);
  await new Promise((r) => setTimeout(r, 900)); // let the panel animation finish
  const img = await win.webContents.capturePage();
  fs.writeFileSync(path.resolve(out), img.toPNG());
  console.log('[shot] wrote', path.resolve(out), win.getBounds());
  ctx.cleanup();
  app.exit(0);
}).catch((e) => {
  console.error('[shot] failed:', e.message);
  ctx.cleanup();
  app.exit(1);
});
