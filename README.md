# Blob — floating overlay for the Thread Axis Method

Task dump, Eisenhower tag after capture, a horizontal axis showing open
threads, and a lifetime scoreboard. The ambient state is a single glass
blob in the top-right corner of the screen.

## Run it

As an app (what you normally want):
```
npm install
npm run install-app     # builds dist/mac-arm64/Blob.app and copies it to /Applications
open -a Blob
```
Then launch it from Launchpad, Spotlight, or the Dock like any app. Re-run
`npm run install-app` after changing the code.

For development:
```
npm start
```
(Needs Node.js installed on the Mac.)

## Calling it back
- **Menu bar:** the small ring-with-two-dots icon. Left-click toggles the
  blob, right-click gives Show / Hide / Quit.
- **Dock:** click the Blob icon.
- **Hotkey:** `⌘⇧Y` from anywhere.
- The "–" in the panel header, and ⌘W, only hide it; any of the above brings
  it back. Launching Blob a second time just reveals the running one. If the
  window is ever lost entirely, or its renderer dies, the same actions
  rebuild it.

## How it sits on screen
- **Ambient:** one glass blob in the top-right of the screen with a small
  coloured core per open thread (red = Q1, blue = Q2, yellow = Q3, grey =
  Q4), up to four plus a "+n". No open threads = a dashed ghost blob.
- **Hover the blob** and the panel unfolds below it. Move the mouse away
  and it folds back after a 300 ms grace period. `Esc` also closes it.
  Clicking the blob opens the panel with the input ready.
- The window is resized to exactly the visible content, so when only the
  blob is showing, clicks land on whatever is underneath the rest of the
  old rectangle. The panel header is draggable; the blob follows the
  top-right corner of wherever you leave it.

## Use it
- Type a task in the box at the bottom, hit Enter. It appears as a row
  above the box, untagged, with four small Q1–Q4 dots.
- **Tap a dot** to tag it. Tagging never moves it by itself — it only sets
  order (the paper's point). Tap the coloured chip any time, on a dump or
  an axis row, to retag.
- **Tap →** on a tagged dump row to push it onto the axis (a bar and a
  core in the blob). **Tap ←** on an axis row to recall it back to the
  dump if you're not actually working it yet — same tag, same row, just
  off the axis until pushed again.
- **Click a thread's text** to focus it: gold ring on the blob, its core,
  its bar and its row. Click again to clear. One focus at a time.
- **Hover** a core, a bar or a row and the other two light up.
- **Close a thread** by clicking its bar or its row's ✓. Its bar leaves
  the axis immediately — closed work never crowds it — and the other bars
  spread into the room it leaves. The row stays in the list, struck
  through with a ↺ to reopen it, until you delete it. New bars slide the
  existing ones over to bundle in.
- **Reopen a closed thread** with the ↺ on its row (or right-click →
  Reopen). It goes straight back on the axis and the scoreboard gives the
  point back.
- **Right-click a row → Delete** removes a task for good. Bars have no
  right-click.
- **Scoreboard** at the bottom: "Done 2/10" is tasks closed out of tasks
  ever listed, plus how many are active. Lifetime counters stored in
  `threads.json` under `stats`; deleting a task does not shrink them. The
  blob's tooltip shows the same line.
- **⚙ (left of – and ×)** flips the panel to a second screen: the big
  crossed-off count, every task ever closed (kept in `threads.json` under
  `history`, so it survives deleting the row; reopening removes it), and
  Settings — currently just Launch at login. Esc or "← back" returns;
  collapsing the panel always lands back on the main screen.

Change the hotkey by editing `HOTKEY` at the top of `main.js`.

## Architecture
Layers, with dependencies pointing one way. ES modules, no bundler and no build
step: `index.html` loads one entry point, `src/ui/app.js`.

| Where | Role | May import |
|---|---|---|
| `src/core/` | Pure logic. Today: the item state machine (`itemStore.js`: `addTask`, `tagTask`, `dispatchToAxis`, `recallToDump`, `resolveThread`, `reopenTask`, `deleteTask`, `toggleFocus`). No DOM, no Electron, no I/O: persistence and the change callback are injected. It runs in plain Node, which is where it is tested, and a phone app could reuse it unchanged. | only other `src/core/` files |
| `src/ui/views/` | One file per thing on screen: `orbView`, `axisView`, `inboxView`, `scoreView`, `doneView`, plus `itemRow` (one row). A view is `createXView(elements, actions)` returning `{ render(snapshot, ui), applyHover?(id) }`. It draws from a **frozen snapshot** and reports what the user did through `actions`. It can't reach the store or the bridge. | `ui/dom`, `ui/theme`, `ui/format`, `core/selectors` |
| `src/ui/` | The page's machinery, one job per file: `bridge` (the only file that reads `window.threadAxis`), `snapshot`, `hover`, `panel` (fold-out animation + window sizing), `screens`, `tooltip`, `rowMenu`, `dom`, `format`, `theme`. | each other, sparingly |
| `src/ui/app.js` | The composition root. Looks up the page's elements (the only file that knows the ids in `index.html`), creates the store and the views, and hands each only the elements and actions it needs. | everything in `src/` |
| `preload.js` | The only bridge between the page and Electron (IPC). | Electron |
| `main.js` | The OS shell: window, tray, hotkey, reading/writing `threads.json`. | Electron, Node |

Rules that keep it rebuildable:
- **Transitions live in `src/core/itemStore.js` only.** It guards each one, so
  an impossible move (say, closing a thread that's in the dump) is a no-op.
  The UI never sets `t.status` itself; it asks through an action and redraws.
- **Views can read state but structurally cannot change it.** `app.js` renders
  from `takeSnapshot(store.state)`, a deep-frozen copy, and ES modules are
  strict, so a stray write throws instead of silently corrupting data. UI-only
  state (which row is being retagged, what is hovered) lives in the UI and is
  never written onto the data.
- **One door for each outside thing.** `window.threadAxis` only in
  `ui/bridge.js`; the ids of `index.html` only in `ui/app.js`. Hover sync works
  by each view repainting its own elements (`applyHover`), never by one view
  reaching into another's DOM.
- **Nothing parses markup:** `innerHTML` is only ever assigned `''` (to clear).
  Text goes through `textContent`, SVG through `svgEl`.
- **A bar outlives the snapshot it was drawn from,** so click handlers on
  long-lived elements look the item up in the *latest* snapshot rather than
  trusting the one they were created with.
- **New source files must be covered by `build.files` in `package.json`**
  (`src/**` and `main/**` already are). Otherwise the packaged app ships
  without them while `npm start` keeps working, which is a nasty one to find.
- **`main.js` never trusts its window.** Every call goes through
  `liveWindow()` (a destroyed window throws on every method), closing hides
  (⌘W is in Electron's default menu), only a real quit lets it close, and a
  dead renderer is reloaded (at most 3 a minute). Before this, one stray ⌘W
  left Blob running with no window, and the hotkey, tray and Dock all threw
  "Object has been destroyed".

## Tests
```
npm test
```
Runs `test/taskStore.test.js`: plain Node, no Electron, about a second (one
case waits out the 700 ms close animation). It drives the state machine
against a fake in-memory persistence object and also guards the rules above
(no DOM in the store, no global-name collisions with `renderer.js`). Change a
transition, change its test.

```
npm run test:ui
```
The safety net for the UI. It boots the real main process on fixture data and
drives the real DOM like a user would (capture, tag, push, recall, close,
reopen, focus, hover, right-click, the crossed-off screen, Esc, hide/show,
quit), checking both what is on screen and what lands in `threads.json`. It
knows nothing about renderer internals, only the DOM contract (ids, classes,
text) and the file, so it must stay **unchanged** through any refactor: if a
check has to change for a refactor to pass, the refactor changed behaviour.
Same requirements as `test:app` below.

```
npm run test:app
```
The Electron-level check for `main.js`. It boots the real main process, then
does the things that can strand an overlay app (⌘W, a destroyed window, a
killed renderer, a renderer that dies on every load) and checks that Blob
recovers and still quits. It needs a GUI session and briefly shows a Blob
window, a tray icon and a Dock icon (~20 s), so don't type while it runs. Both
Electron tests use fixture data and their own profile (see
`scripts/lib/isolatedApp.js`), never your `threads.json`, so they are safe to
run while Blob is open.

```
npm run verify            # everything: unit + test:app + test:ui
npm run verify:packaged   # test:app + test:ui against the code inside the BUILT app.asar
```
`verify:packaged` (after `npm run build`) is what catches a file missing from
the package while `npm start` still works: run it before every install.

## Debugging
- `THREAD_AXIS_DEBUG=1 npm start` logs every window resize and forwards
  renderer console output to the terminal.
- **Screenshots:** `npx electron scripts/shot.electron.js out.png ["js to run in the page"]`
  boots the app on sample data, runs the JS (default: hover the blob so the
  panel unfolds), writes a PNG and quits. To see your own tasks, point
  `BLOB_SHOT_DATA` at a **copy** of `threads.json`; it is only ever written to a
  temp dir. Blob can keep running.
- **Never** run `npm start` to poke at the app while the installed Blob is up: it shares
  the installed app's single-instance lock (so it just reveals the running one) and
  writes your real `threads.json`. Use the tools above, or run isolated by hand:
  ```
  cp ~/Library/Application\ Support/thread-axis/threads.json /tmp/blob-test.json
  THREAD_AXIS_DATA=/tmp/blob-test.json npx electron . --user-data-dir=/tmp/blob-test-profile
  ```
  (`THREAD_AXIS_DATA` moves the data file; `--user-data-dir` gives the run its own
  single-instance lock. A fake `$HOME` does not work on macOS.)

## macOS "malware" dialog
Electron's prebuilt binary is only ad-hoc signed. If macOS ever shows
"Malware Blocked and Moved to Bin" for `Electron.app`, Apple has revoked
that Electron version's code hash (this happened with 31.7.7 on macOS
26.5). Fix: bump the `electron` version in `package.json` and reinstall.

## Packaging notes
`npm run build` produces `dist/mac-arm64/Blob.app` (ad-hoc signed, no
Developer ID). Because it is built locally it carries no quarantine flag,
so Gatekeeper does not prompt. Icons: `assets/icon-1024.png` →
`build/icon.icns`, menu bar template in `assets/blobTemplate*.png`.

Data persists to `~/Library/Application Support/thread-axis/threads.json`
for both the app and `npm start` (the path is pinned in `main.js`).
