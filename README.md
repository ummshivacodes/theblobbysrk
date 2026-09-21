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
  above the box, untagged, with four small Q1–Q4 dots and a violet **N**.
  Several lines (Shift+Enter, or pasted): the first line is the title and the
  rest become the row's notes.
- **⌘↵ instead of Enter** saves it as a note, not a task: it never shows up in
  the list, and the header's **N** counts it (it pulses when the count goes up;
  the screen for reading your notes is the next step of the notes work).
- **N beside Q1–Q4** does the same for something already in the dump: it isn't
  a task, so it leaves the list and stops counting toward "Done x/y". Only
  items still in the dump can be filed; recall an axis thread first.
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
- **▸ on any row** opens its notes: room for more than a title. A row with no
  notes opens a text box with the cursor in it; otherwise you see the text as
  written, and clicking it edits. It saves as you type (a moment after you
  pause), when you click away, and on ⌘↵ or Esc. Esc keeps what you typed, it
  never throws it away. The ▸ is violet when a row has notes. The panel won't
  fold away while you're in the middle of typing; it folds when you stop, if
  the mouse is still away.
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
| `src/core/` | Pure logic. `itemStore.js`: the item state machine — tasks (`addTask`, `tagTask`, `dispatchToAxis`, `recallToDump`, `resolveThread`, `reopenTask`) and notes (`addNote`, `fileAsNote`, `unfileNote`, `setBody`, `setText`, `setLinkTitle`), plus `deleteItem` and `toggleFocus` for either. `selectors.js`, `capture.js`, `linkify.js`, `migrate.js` (schema v2). No DOM, no Electron, no I/O: persistence and the change callback are injected. It runs in plain Node, which is where it is tested, and a phone app could reuse it unchanged. The UI so far calls `setBody` (the notes editor), `addNote` (⌘↵) and `fileAsNote` (the N dot); the Notes screen, `unfileNote` and links arrive with the rest of Phase 4. | only other `src/core/` files |
| `src/ui/views/` | One file per thing on screen: `orbView`, `axisView`, `inboxView`, `scoreView`, `doneView`, plus `itemRow` (one row), `bodyEditor` (an item's notes: read text ↔ textarea) and `notesBadgeView` (the header's N and its count). A view is `createXView(elements, actions)` returning `{ render(snapshot, ui), applyHover?(id) }`. It draws from a **frozen snapshot** and reports what the user did through `actions`. It can't reach the store or the bridge. | `ui/dom`, `ui/theme`, `ui/format`, `views/itemRow`, `views/bodyEditor`, `core/selectors`, `core/linkify` |
| `src/ui/` | The page's machinery, one job per file: `bridge` (the only file that reads `window.threadAxis`), `snapshot`, `hover`, `panel` (fold-out animation + window sizing), `renderGate` (holds a redraw while the user is mid-gesture), `pressGuard` (a press on a button doesn't pull focus out of an open editor), `captureBox` (what a key in the capture box means: Enter, ⌘↵, several lines, input methods; a pure function, unit-tested), `screens`, `tooltip`, `rowMenu`, `dom`, `format`, `theme`. | each other, sparingly |
| `src/ui/app.js` | The composition root. Looks up the page's elements (the only file that knows the ids in `index.html`), creates the store and the views, and hands each only the elements and actions it needs. | everything in `src/` |
| `style.css`, `styles/` | Styling. `style.css` is the original; each new feature adds a file under `styles/` (loaded after it by `index.html`) instead of growing it. | – |
| `preload.js` | The only bridge between the page and Electron (IPC): `window.threadAxis`. | Electron |
| `main.js` | The composition root of the main process: builds each part below, hands it what it needs, registers IPC, listens for the app-level events (single-instance lock, quit, activate). No logic of its own. | Electron, `main/` |
| `main/window.js` | The overlay window and everything that keeps it alive: closing hides (only a real quit lets it close), a missing window is rebuilt on demand, a dead renderer is reloaded (capped at 3/minute), and the navigation lockdown (`setWindowOpenHandler` denies, `will-navigate` is prevented — the page can never open or become another page). | Electron |
| `main/tray.js` | The menu-bar icon and its menu. | Electron |
| `main/ipc.js` | The only file that registers an IPC channel (`ipcMain.*`) — literal calls, so the channel names can be read straight off the file and checked against `preload.js`. | Electron, the parts above |
| `main/persistence.js` | `threads.json`: atomic write, daily backups, quarantines a file it can't read (or that parses but isn't a valid state) rather than ever overwriting it. | Node only — no Electron |
| `main/links.js`, `main/lib/*` | Opening a link (re-validates the URL; the main process never trusts the page) and fetching a page's title for a captured bare URL. | Node only — no Electron |
| `main/settings.js` | The one real setting: launch at login. | Electron |

Rules that keep it rebuildable:
- **Transitions live in `src/core/itemStore.js` only.** It guards each one, so
  an impossible move (say, closing a thread that's in the dump) is a no-op.
  The UI never sets `t.status` itself; it asks through an action and redraws.
- **Views can read state but structurally cannot change it.** `app.js` renders
  from `takeSnapshot(store.state)`, a deep-frozen copy, and ES modules are
  strict, so a stray write throws instead of silently corrupting data. UI-only
  state (which row is being retagged, what is hovered) lives in the UI and is
  never written onto the data.
- **The page is never redrawn under the user's hands.** Every change redraws
  everything from the snapshot, so a change landing mid-gesture would destroy a
  note being typed or, between mouse-down and mouse-up, swallow a click.
  `ui/renderGate.js` holds the redraw while the pointer is down or a notes
  editor has focus, and draws once when the gesture ends; `ui/pressGuard.js`
  keeps a press on a button from pulling focus out of an open editor (the
  editor would shrink under the pointer and the click would land on nothing).
  A new view that keeps transient state adds itself to what `app.js` calls
  "held"; it does not work around this itself.
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
- **`main/window.js` never trusts its window.** Every call goes through
  `liveWindow()` (a destroyed window throws on every method), closing hides
  (⌘W is in Electron's default menu), only a real quit lets it close, and a
  dead renderer is reloaded (at most 3 a minute). Before this, one stray ⌘W
  left Blob running with no window, and the hotkey, tray and Dock all threw
  "Object has been destroyed". It also locks the page down so it can never
  navigate away or open another window — see the table above.

## Tests
```
npm test
```
Plain-Node unit tests (`test/unit/*.test.mjs`, on `node:test`): no Electron, no
window, well under a second. They cover the item state machine against a fake
in-memory persistence object (every transition and its no-op cases; the 700 ms
close animation runs on mock timers), the pure logic in `src/core/` (selectors,
capture, link detection, data migration), the main-process helpers in `main/`
(safe saving with backups, link fetching), and the small UI helpers that need no
DOM (snapshot freezing, hover, timestamp formatting, the redraw gate). Change a transition,
change its test.

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
npm run test:notes
```
The same kind of test for the notes UI (the ▸ expander and body editor, the N
dot, ⌘↵ and multi-line capture so far; later steps add the Notes screen and
links). It is a separate file
on purpose: `test:ui` pins today's behaviour and stays unchanged, this one grows
with the feature. It covers typing, autosave, ⌘↵ and Esc, the redraw being held
while you type, the panel not folding mid-sentence, hiding the window while
typing, and a real (trusted) mouse press on a button while an editor is open.
Its window is sealed off from you: it can't take keyboard focus, it ignores
your real mouse, and the show/hide events the page reacts to are sent by the
test itself (macOS reports a window as "hidden" when something merely covers
it, which made timing checks fail at random). Input the test injects goes
straight to the page, so it is unaffected. Don't loop it: one run per change.

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
npm run verify            # everything: unit + test:app + test:ui + test:notes
npm run verify:packaged   # the three Electron tests against the code inside the BUILT app.asar
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
