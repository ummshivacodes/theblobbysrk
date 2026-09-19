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
- The "–" in the panel header only hides it; any of the above brings it back.
  Launching Blob a second time just reveals the running one.

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

## Debugging
- `THREAD_AXIS_DEBUG=1 npm start` logs every window resize and forwards
  renderer console output to the terminal.
- `THREAD_AXIS_SELFTEST=1 npm start` drives expand → add → close → gear
  screen → reopen → delete from the main process so the whole flow can be
  checked without a mouse. It cleans up after itself.
- `THREAD_AXIS_SHOT=out.png [THREAD_AXIS_EVAL="js"] npm start` runs some
  JS in the renderer (default `openPanel()`), captures the window to a PNG
  and quits. E.g. `THREAD_AXIS_EVAL="openPanel(); setTimeout(() => showScreen('done'), 300)"`.
- Both need the installed Blob quit first: it holds the single-instance
  lock, so `npm start` just reveals it and exits silently.

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
