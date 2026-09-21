// Boots the REAL main process in a sandbox, for the Electron tests and the screenshot tool: fixture
// data in a temp dir, and its own Electron userData (which is also where the single-instance lock
// lives). So it can never read or write the owner's real threads.json, and it is safe to run while
// Blob itself is running.
//
// There is deliberately no way to call this without a fixture: a test that "falls back to the real
// file" is exactly how sample rows once leaked into real data.
//
// Must be required from an Electron main-process script (it needs `electron`).
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.join(__dirname, '..', '..');

// mainPath defaults to BLOB_MAIN, so the same tests can run against the packed app.asar
// (see scripts/verify-packaged.sh), else to the repo's main.js.
function bootIsolatedApp({ fixture, mainPath = process.env.BLOB_MAIN || path.join(REPO, 'main.js') }) {
  if (!fixture || typeof fixture !== 'object') throw new Error('bootIsolatedApp needs a fixture object');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'blob-isolated-'));
  fs.mkdirSync(path.join(tmp, 'profile'));
  app.setPath('userData', path.join(tmp, 'profile')); // before main.js asks for the single-instance lock
  const dataFile = path.join(tmp, 'threads.json');
  fs.writeFileSync(dataFile, JSON.stringify(fixture));
  process.env.THREAD_AXIS_DATA = dataFile;
  require(mainPath);
  return {
    app,
    BrowserWindow,
    tmp,
    dataFile,
    readData: () => JSON.parse(fs.readFileSync(dataFile, 'utf8')),
    cleanup: () => {
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* temp dir; the OS clears it */ }
    },
  };
}

module.exports = { bootIsolatedApp };
