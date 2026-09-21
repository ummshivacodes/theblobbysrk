# Blob → on-the-go note taker: implementation plan

Status: **in progress: see section 11 (progress log) for exactly how far it got.** Written 2026-09-21
as a handoff: whoever implements this (any model, any session) should be able to work from this file alone.

Out of scope, on purpose: phone app, brain map, markdown export, sync, tags. They are deferred,
and section 8 shows the seam each one will plug into, so none of them forces a rebuild later.

---

## 1. What we are building

Blob stays what it is: a floating overlay for *what am I on right now*. It gains one idea:

> **The dump takes anything. The tag decides what it is.**
> Q1–Q4 makes it a task (today's behaviour). **N** makes it a note. Notes never touch the axis.

Three user-facing features:

1. **Notes.** A fifth tag, `N`, files an item as a note. It leaves the main list and lives on a new
   Notes screen (search, read, edit, send back to the dump, delete). `⌘↵` in the capture box saves
   straight to Notes.
2. **A body on every item.** Rows expand to a multi-line text area, for notes and for tasks.
   Pasting several lines splits into title (first line) + body (the rest).
3. **Links are links.** URLs in titles and bodies open in the browser. A captured bare URL shows
   the page's title instead of `https://www.instagram.com/reels/DdVs…`.

And one non-negotiable engineering requirement from the owner:

> **ALWAYS build on SOLID principles, modular, no cross wires. A change must never force a rebuild.**

So the order is: **safety net → modularize (no behaviour change) → domain → UI.** Features are
added to a structure that can take them, not piled onto `renderer.js` (542 lines, one scope) and
`main.js` (240 lines: window + tray + IPC + disk + test hooks).

## 2. Verified before planning (don't re-litigate)

Checked on this machine (Electron 44.4.2, Node 25.9.0) on 2026-09-21:

| Assumption | Result |
|---|---|
| Native ES modules (`<script type="module">`) load under `file://` with the app's CSP (`default-src 'self'`) | ✅ works |
| …also from inside a packed `.asar` (how the installed app ships) | ✅ works |
| Two modules may both declare `const COLORS` (the classic-script collision that nearly blanked the app) | ✅ no collision; nothing leaks to `window` |
| The preload bridge (`contextIsolation: true`) works next to a module script | ✅ |
| Plain Node imports the same files when `src/package.json` is `{"type":"module"}` | ✅ |
| `node --test "test/unit/**/*.test.mjs"` runs only unit tests, even with spaces in the repo path | ✅ (a bare `node --test` would also pick up the Electron tests; always pass the glob) |

So: **ES modules, no bundler, no build step.** Imports make every dependency explicit and checkable.

## 3. Target structure

```
index.html                 one <script type="module" src="src/ui/app.js">
style.css                  existing styles, untouched; new styles go in styles/notes.css
preload.js                 CJS. The only renderer↔Electron bridge (window.threadAxis)
main.js                    CJS. Composition root of the main process (~40 lines)
main/
  window.js                create / liveWindow / show / hide / toggle; close→hide; crash→reload; navigation lockdown
  tray.js                  tray icon + menu
  persistence.js           threads.json: atomic write, backups, corrupt-file quarantine (takes a dir; no Electron import)
  links.js                 openExternal (http/https only) + fetchTitle (net.fetch, 5 s timeout, 256 KB cap)
  ipc.js                   the ONE place channels are registered: a table of channel → service call
  lib/safeUrl.js           pure: string → URL | null (http/https only)
  lib/titleFromHtml.js     pure: html → title (og:title > twitter:title > <title>; decode entities; ≤120 chars)
src/
  package.json             {"type":"module"}
  core/                    PURE: no DOM, no Electron, no I/O. Runs in Node today, in a phone app later.
    itemStore.js           the state machine (today's taskStore.js + note transitions)
    history.js             toHistory (shared by itemStore and migrate)
    selectors.js           activeThreads, inboxItems, notes, searchNotes (pure functions of state)
    capture.js             parseCapture(raw) → {text, body};  isBareUrl(text)
    linkify.js             linkify(text) → [{type:'text'|'link', value, href?}]
    migrate.js             migrate(saved) → schema v2; total, idempotent, never throws
  ui/
    app.js                 composition root: bridge → store → views; builds the `actions` objects
    bridge.js              the ONLY file that reads window.threadAxis → {persistence, windowCtl, links, settings, lifecycle}
    theme.js               COLORS, quad labels            (COLORS leaves the store: it is presentation)
    dom.js  format.js      el(), svgEl(), renderSegments();  fmtWhen(), "edited 2h ago"
    panel.js               open/close animation + window sizing
    screens.js             'main' | 'notes' | 'done'
    hover.js  tooltip.js  rowMenu.js
    views/
      orbView.js  axisView.js  scoreView.js  doneView.js
      inboxView.js         main-screen list
      notesView.js         notes screen
      itemRow.js           shared row: expander, title, chip/dots, actions
      bodyEditor.js        read (links clickable) ↔ edit (textarea)
styles/notes.css
test/unit/*.test.mjs       plain Node: core + main/lib + main/persistence + architecture rules
test/app/lifecycle.electron.js   (exists; moves here)
test/app/ui.electron.js    black-box UI test on fixture data
scripts/shot.electron.js   screenshot helper (replaces the SHOT hook inside main.js)
```

### Dependency rules (enforced by `test/unit/architecture.test.mjs`, not by good intentions)

```
src/core/*      → src/core/* only. Never mentions window, document, require(, electron.
src/ui/views/*  → ui/dom, ui/theme, ui/format, views/itemRow, views/bodyEditor, core/selectors, core/linkify.
                  NEVER core/itemStore, NEVER ui/bridge. Views are handed what they need.
src/ui/bridge   → the only file containing "window.threadAxis".
src/ui/app      → may import anything in src/. The only place things are wired together.
main/*          → electron, node, main/lib. Never src/.   src/ never imports main/.
main/ipc.js     → the only file containing "ipcMain.".     preload.js → the only "ipcRenderer".
```
The same test also checks: every channel used in `preload.js` is registered in `main/ipc.js` (and
vice versa); `innerHTML` is only ever assigned `''`; `package.json` `build.files` covers `src/**`
and `main/**` (the packaging trap from the last refactor).

### Contracts

- **Store:** `createItemStore(persistence, onChange)`: unchanged shape. `persistence` and `onChange`
  are injected; the store imports nothing.
- **View:** `createXView(rootEl, actions) → { render(snapshot, ui), applyHover?(id) }`.
  `actions` is a plain object of functions built in `app.js`, and each view gets **only the ones it
  uses** (orbView gets `{openPanel}`; inboxView gets `{tag, push, recall, resolve, reopen, fileAsNote,
  setBody, focus, remove, openLink}`). Views keep only throw-away UI state (which row is expanded,
  which row is retagging, the search text).
- **Views cannot mutate state, by construction:** `app.js` renders from
  `deepFreeze(structuredClone(store.state))`. ES modules are always strict mode, so a stray write
  throws instead of silently corrupting data. (Dozens of small items; the clone is free.)
- **`retagging` leaves the store.** It is a UI flag that today lives on thread objects and gets
  stripped at save. It becomes `inboxView`-local; the store and its tests stop knowing about it.
- **Readiness flag:** `app.js` ends with `document.documentElement.dataset.ready = '1'`. Tests wait
  for that instead of poking renderer globals (there are none any more).

## 4. Data model v2

```js
// threads.json
{ version: 2, threads: [Item], stats: { listed, done }, history: [...] }

Item = {
  id, text, createdAt,
  status: 'dump' | 'axis' | 'resolving' | 'done' | 'note',   // 'note' is new
  quad: 1 | 2 | 3 | 4 | null,                                 // always null for a note
  body?: string,          // new; any item
  updatedAt?: number,     // new; the last CONTENT edit (see the updatedAt policy below); sorts the Notes screen
  linkTitle?: string,     // new; fetched page title when `text` is a bare URL
  doneAt?, focused?       // unchanged
}
```
`status` stays the single discriminator, so everything that filters by status keeps working and a
note can't be half-task. Migration v1→v2 only stamps `version: 2`: every new field is optional, so
existing data needs no rewrite. The key stays `threads` (file-format stability beats a nicer name).

**Input rules (the store owns the shape of its data, whoever calls it).** A title is stored trimmed and can
never be blank; a body is stored with its tail trimmed, and an empty body means no `body` key; anything that
is not a string counts as empty (it must never be stored as `"42"` or `"[object Object]"`). `addTask` and
`addNote` return the new id, or `null` when there was nothing to capture. `unfileNote` clears any stray `quad`.

**`updatedAt` policy, and what it costs.** It is stamped by content edits only: `addNote`, `addTask` (when a
body is given), `fileAsNote`, `unfileNote`, `setBody`, `setText`, `setLinkTitle`. It is deliberately **not**
stamped by the task lifecycle (`tagTask`, `dispatchToAxis`, `recallToDump`, `resolveThread`, `reopenTask`,
`toggleFocus`), so a task row's on-disk shape stays what the Phase 0 UI test pins. The cost: a future sync
merge cannot see *status* changes on tasks. When sync is built it must extend the stamp to every mutation
deliberately, and update that UI-test check in the same commit (and backfill on load, since old rows have none).
(Earlier drafts of this plan said "set by every mutation"; that was dropped for the reason above.)

New transitions (each guarded like the existing ones; an impossible move is a no-op):

| Function | Allowed from | Effect |
|---|---|---|
| `addNote(text, body?)` | – | new item, `status:'note'`, `createdAt` = `updatedAt` = now; does **not** bump `stats.listed`; blank title → returns `null`, a true no-op |
| `fileAsNote(id)` | `dump` | → `note`, `quad = null`, `stats.listed--` (floor 0): it was never a task |
| `unfileNote(id)` | `note` | → `dump`, untagged, `stats.listed++` |
| `setBody(id, body)` | any but `resolving` | trims the end (keeps the start); empty or non-string → deletes the key; saving what is already stored is a no-op |
| `setText(id, text)` | any but `resolving`/`done` | trimmed; blank, non-string or unchanged is ignored; drops `linkTitle` (it described the old text) |
| `setLinkTitle(id, url, title)` | any | only if `text.trim() === url` still holds; blank/non-string ignored; the same title again is a no-op |
| `addTask(text, body?)` | – | gains the optional body (`updatedAt` only when a body is given); blank title → returns `null` |

Tightened while we're here (found by porting the store tests; each gets a test):
- `tagTask` also no-ops on `note`; `dispatchToAxis` also requires a quad (today only the UI enforces that);
  `deleteTask` is renamed `deleteItem` and no longer saves or re-renders for an unknown id.
- `resolveThread` only acts on `axis`. Today a second call inside the 700 ms window, or a call on a done
  thread, counts the point twice (`stats.done` +2, two history entries).
- Deleting an item cancels its pending resolve (the store tracks the timer per id). Today a deleted thread
  still "completes": `stats.done` goes up, a history entry appears, a save happens.
- `loadState` runs `migrate` first, then reverts any `resolving` thread to `axis`. Today quitting inside the
  700 ms window (any other mutation saves the transient state) reloads a thread stuck as `resolving`
  forever. Reverting is safe and consistent: the score and history only change when the 700 ms finishes,
  so nothing had been counted.
- New ids can't collide (a counter or random suffix on top of the timestamp).
"Done 11/20" stays a task ratio: notes never count as listed.

## 5. UI spec

- **Row:** `[▸] title  [chip | Q1 Q2 Q3 Q4 N]  [actions]`. `▸` expands the body editor under the
  row; it is brighter when a body exists.
- **N dot:** files the item; the row leaves the list; the header Notes button pulses and its count
  goes up.
- **Capture box:** `Enter` = dump (as today). `⌘↵` = save as note. Multi-line paste → title + body.
  Ignore `Enter` while `e.isComposing`. Placeholder: `dump a task or a thought…   ⌘↵ = note`.
- **Header:** `Blob  ⌘⇧Y   [✎ n] [⚙] [–] [×]`. `✎` toggles the Notes screen.
- **Notes screen:** search box (focused on open; every word must match title, body or link title) →
  list, newest edit first (title, first body line, "edited 2h ago") → expand to read/edit →
  `↩` back to the dump, right-click → Delete. `Esc` returns to main. Friendly empty state.
- **Body editor:** empty → textarea at once. Otherwise rendered text (`white-space: pre-wrap`, links
  clickable); click to edit; blur or `⌘↵` saves; `Esc` cancels (and must not also close the panel).
  Grows to ~140 px, then scrolls. Saves are also flushed when the panel closes.
- **Panel must not close mid-sentence:** while an input/textarea inside the panel has focus,
  mouse-leave does not collapse it. Window blur (clicking another app) flushes edits and collapses.
- **Links:** `linkify` → segments → DOM nodes. Never `innerHTML`. Click → `actions.openLink(href)` →
  bridge → main, which validates again (`safeUrl`: http/https only) before `shell.openExternal`.
  The overlay window itself can never navigate: `setWindowOpenHandler(() => ({action:'deny'}))` and
  `will-navigate` → `preventDefault()`.
- **Link titles:** after a capture whose text `isBareUrl`, `app.js` calls `links.fetchTitle(url)`
  and, on success, `store.setLinkTitle(id, url, title)`. Fire-and-forget; failure is silent. The row
  shows the title plus the domain in muted text, else a shortened URL. (Instagram often hides titles
  from non-browsers; the fallback is the normal case there, not an error.)
- Window size is unchanged: lists scroll inside the fixed 420 px panel.

## 6. Data safety (notes are worth more than tasks)

Today a crash mid-write corrupts `threads.json`; the next launch reads `null`, starts empty, and the
next save overwrites everything. `main/persistence.js` fixes that:

- **Save:** write `threads.json.tmp` → fsync → rename over the real file (atomic on APFS).
- **Backups:** before the first save of each run, copy the good file to `threads.backup.json`, plus
  one dated copy per day in `backups/` (keep 14).
- **Load:** if the main file won't parse, move it aside as `threads.corrupt-<timestamp>.json`, load
  the backup, and return `{data, recoveredFrom:'backup'}` so the UI can show a one-line notice.
  **Never overwrite a file we could not read.**
- Unit-tested in plain Node against a temp dir (round trip, no stray `.tmp`, corrupt main → backup +
  quarantine, both corrupt → empty and nothing deleted, rotation cap). `THREAD_AXIS_DATA` still
  overrides the path, so tests never see real data.

## 7. Phases: one at a time, each ends green and committed

**Rules for the implementer**
1. A phase's **gate** must be green before anything that depends on it starts; independent work
   runs in parallel lanes (section 7a). One phase = one commit (split further if useful), message
   ending with the session's attribution line.
2. **Phases 0–2 change no behaviour.** If a Phase-0 check has to change for a later phase to pass,
   stop and ask.
3. **Never touch live data or the running Blob.** Every Electron run uses fixture data and its own
   `userData` (the test files do this by construction). The live app is quit exactly once: the final
   swap in Phase 5.
4. No fixed sleeps in assertions; poll with `waitFor(condition)`. (A timer-based self-test already
   failed once on this machine just because it was under load.)
5. Every new pure function ships with its unit test in the same commit.
6. If the architecture test blocks you, the design is telling you something. Extend the rules
   deliberately (and say why in the commit); never weaken them to get a green run.

| Phase | What | Gate |
|---|---|---|
| **0. Safety net** | `test/app/ui.electron.js`: a black-box test of **today's** UI on fixture data (one item of every status). It drives the real DOM only: `win.show()` opens the panel, typing + `Enter`, `.click()`, `contextmenu`. Checks: per-status controls; bars/cores/counts; capture; tag (stays in dump) → push → recall; ✓ → strike at once → done, bar gone, score +1; gear screen; ↺; focus; hover sync; right-click Delete; retag; `Esc` behaviour; `–` then show; file on disk matches and has no `retagging`. Move the lifecycle test to `test/app/`, make both Electron tests honour `BLOB_MAIN` (path to `main.js`, so the same tests run against a packed `.asar`), add `npm run test:ui`, `verify`, `verify:packaged`. Add the readiness flag (`<html data-ready="1">` once the first render is done) so tests never poke renderer globals. Retire the SELFTEST hook from `main.js` (this test supersedes it) and move the SHOT hook to `scripts/shot.electron.js`, so `main.js` carries no test code before lane B restructures it. | New test green against the current code, 3 runs in a row |
| **1. Modularize the renderer** | `renderer.js` + `taskStore.js` → `src/` ES modules per section 3 (function → module map below). `retagging` becomes view-local; `COLORS` → `ui/theme.js`; frozen snapshots; readiness flag; store tests ported to `test/unit/*.test.mjs` on `node:test`; architecture test added; `build.files` → globs (already done in the prep commit). | `npm run verify` green; Phase-0 test **unchanged** and green; `verify:packaged` green |
| **2. Modularize main + data safety** | `main.js` → `main/window.js`, `tray.js`, `persistence.js`, `ipc.js`. Section 6. Navigation lockdown. | verify + verify:packaged green; persistence unit tests |
| **3. Notes in the core** | Section 4: `migrate`, new transitions, `selectors`, `capture`, `linkify`, plus `main/lib/safeUrl` and `titleFromHtml`. No UI change yet. | Unit tests green; UI test still unchanged and green |
| **4. Notes UI** | In this order, each its own commit with new UI-test checks: **4a** expander + body editor + the don't-close-while-typing rule · **4b** N dot, `⌘↵`, multi-line paste · **4c** Notes screen · **4d** clickable links + `openExternal` · **4e** link titles · **4f** rename a title (double-click; lowest priority) | verify green after each |
| **5. Ship** | README: Architecture, "Use it", and a short **"How to add a feature"** (which layer, which files). `verify:packaged` → back up `threads.json` → quit Blob → install → relaunch → confirm the window is up and every existing task survived. Refresh `Blob Workbench`. | Owner sees it working |

### 7a. Parallel lanes (added 2026-09-21)

The critical path is **0 → 1 → 3(store) → 4 → 5** and it is strictly sequential, with one owner
(lane A). Two pieces are independent of it and run beside it. Expect roughly 30% less wall-clock,
not 3×, for about 1.5× the tokens. **Never parallelize inside the critical path:** the views share
conventions (the `actions` objects, snapshots, `dom.js`), and drift between them *is* a cross wire.

| Lane | Owner | Owns (edits nothing else) | Work | Starts | Gate |
|---|---|---|---|---|---|
| **A** renderer | main session | `src/ui/**`, `src/core/itemStore.js`, `index.html`, `style.css`, `styles/**`, `test/app/**`, `test/unit/architecture.test.mjs`, `scripts/**`, `package.json`, `README.md`, `docs/**` | Phase 0 → 1 → 3 (store transitions) → 4 → 5, and every merge | now | as in the table above |
| **B** main process | agent | `main/**`, `preload.js`, `main.js` (from B2 on), `test/unit/{persistence,safeUrl,titleFromHtml,links}.test.mjs` | **B1**: additive modules `persistence.js`, `lib/safeUrl.js`, `lib/titleFromHtml.js`, `links.js` (+ tests). **B2** = Phase 2: split `main.js`, wire B1 in, navigation lockdown, additive preload API | B1 now; B2 once Phase 0 is committed | B1: its unit tests. B2: the Phase-0 UI test and the lifecycle test **unchanged** and green |
| **C** pure core | agent | `src/core/{history,migrate,capture,linkify,selectors}.js` and one `test/unit/*.test.mjs` each | Phase 3's pure functions | now | its unit tests |

**Contract between B and A (fixed now, so neither waits on the other):** the existing
`window.threadAxis` API is unchanged. Lane B only **adds** `openExternal(url) → Promise<boolean>`,
`fetchTitle(url) → Promise<string|null>` and `getLoadNotice() → Promise<null | {kind:'recovered-from-backup', at:number}>`.
Lane A's `bridge.js` picks them up in Phase 4; nothing in Phase 1 depends on them. (Main re-validates
every URL with its own `safeUrl` even though `core/linkify` already checks: the main process never
trusts the renderer, so that duplication is deliberate.)

**Mechanics.** Each side lane works in its own git worktree and branch (`.blob-lanes/lane-b`,
`lane-c`, branched from the prep commit); lane A works in the main tree on `main`. Lanes commit only
their own paths. Lane A merges a lane when that lane's gate is green (`git merge --no-ff`, after
checking the branch touched only owned paths), then runs the full `npm run verify`. Shared files
(`package.json`, `README.md`, `docs/`) belong to lane A alone: a lane that needs a change there
reports it. The architecture test (Phase 1) is the integration gate for B and C's files; until it
exists they follow the dependency rules by hand. Run Electron-based tests one at a time if you can:
several at once slow each other down and make timing flaky.

**Reviewer.** Before Phase 5, one fresh agent audits the merged tree against sections 3–5, read-only,
and reports violations.

**Checkpoints for the owner:** after the refactor is merged and green (Phases 0–2, no visible
change), before the visible features start, and before the final swap (Phase 5 restarts the live app).

### Phase 1 map: where today's `renderer.js` goes

| Today | Goes to |
|---|---|
| `createTaskStore(...)`, `render()`, `loadState()`, input/header button wiring | `ui/app.js` |
| `renderScore` | `views/scoreView.js` |
| `fmtWhen` · `renderDoneScreen` + login toggle | `ui/format.js` · `views/doneView.js` |
| `screen`, `showScreen` | `ui/screens.js` |
| `setHovered` | `ui/hover.js` (views expose `applyHover(id)`; no more cross-view `querySelectorAll`) |
| `showTooltip`, `hideTooltip` | `ui/tooltip.js` |
| `MAX_CORES`, `renderOrbs` | `views/orbView.js` |
| `NS`, `AX`, `ensureAxisBase`, `fillBar`, `renderAxis` · `svgEl` | `views/axisView.js` · `ui/dom.js` (build the SVG `<defs>` with `svgEl`, so `innerHTML` is only ever `''`) |
| `tagDots`, `renderList` | `views/itemRow.js` + `views/inboxView.js` |
| `rowMenu`, `showRowMenu`, `hideRowMenu` | `ui/rowMenu.js` |
| `openPanel`, `closePanel`, `scheduleClose`, sizing, shell hover listeners, `onShown`/`onHidden`, `Esc` | `ui/panel.js` |

## 8. Deferred, and the seam each one plugs into

| Later | Plugs in at | Touches nothing else because |
|---|---|---|
| Markdown mirror (`~/Notes/Blob/*.md`, an Obsidian vault for free) | new `main/noteExport.js`, called from the save handler in `main/ipc.js` | it only reads saved data |
| `#tags` and `[[links]]` → brain map | new `core/tags.js` parsing note **bodies**, plus a selector | they live in the text: no schema change |
| Sync (iCloud / Supabase) | swap `bridge.persistence` | the store only knows the injected interface. `updatedAt` exists for content edits; extending it to every mutation is part of the sync work (see the policy under section 4) |
| Phone app | reuse `src/core/` unchanged, tests included | core has no DOM and no Electron, and the architecture test keeps it that way |
| Axis bar colours / label overlap (open since 2026-09-19) | `views/axisView.js` alone | one view, one file |

Not planned: TypeScript (needs a build step; add `// @ts-check` + JSDoc typedefs in `core/` if
editor type-checking is wanted), a CSS reorganisation, a second hotkey.

## 9. Defaults chosen so nobody is blocked (owner can veto any)

`N` for the note dot · `✎` for the Notes button · `⌘↵` = capture as note · filed notes leave the
main list · link-title fetching on · one JSON file (revisit if it passes ~5 MB).

## 10. Known issues found along the way (not fixed in Phases 0–2, which change no behaviour)

Each has a natural home; none blocks the notes work.

| Issue | Found by | Fix belongs in |
|---|---|---|
| **Hide → show within milliseconds leaves the panel "open" but hidden.** `win.hide()` flips `isVisible()` at once but Electron's `hide` event reaches the page slightly later, so a mashed hotkey can reorder "collapse" and "open". A human takes seconds, so normal use is fine. | Phase 0 UI test (it failed twice, differently, until it waited for the page to process the hide) | `main/window.js` (send the events with a sequence number) or `ui/panel.js` (ignore a stale collapse) |
| **`resolveThread` has no status guard** (only the UI's call sites gate it), so a double call counts the point twice; **deleting a thread mid-resolve** still completes it; **quitting mid-resolve** reloads it stuck as `resolving` forever; `loadState` trusts the file (stats without `done` become NaN after one completion). | The store test port (lane E reproduced each in memory) | Phase 3: see the list under section 4 |
| **Axis bars render as thin white lines** instead of the intended coloured pins: the `raise`/`groove` SVG filters use the default objectBoundingBox on zero-width/height lines, so the coloured bar is clipped to nothing. Fix is `filterUnits="userSpaceOnUse"` with explicit regions. Owner hasn't decided (thick bars are busier). | Screenshots on 2026-09-19 | `views/axisView.js`, on the owner's say-so |
| **Axis labels overlap** once about five threads are open (the axis is a fixed 300 units wide). Idea: label only the hovered/focused bar. | Same | `views/axisView.js` |
| **Ids can collide** if two items are created in the same millisecond (`Date.now().toString(36)`). Unreachable by typing; matters if a paste ever creates several items at once. | Reading `itemStore.addTask` while porting | `core/itemStore.js`: add a counter or random suffix, with a test |
| **`Esc` with the right-click menu open also collapses the panel** (both handlers fire). | Writing the UI test (deliberately not asserted) | `ui/app.js` |

## 11. Progress log and integration notes

Kept current so a new session (or a different model) can pick up exactly where this stopped.

**2026-09-21**
- **Phase 0 done** (`16554dc`): `test/app/ui.electron.js` (64 checks) + `test/app/lifecycle.electron.js` (12), shared
  `scripts/lib/isolatedApp.js` and `test/app/harness.js`, `npm run verify` / `verify:packaged`, readiness flag,
  SELFTEST/SHOT hooks retired from `main.js`. Verified to catch 3 planted regressions.
- **Phase 1 renderer split done on branch `phase-1`**: 18 modules under `src/`, the Phase-0 UI test passes with
  **zero changed lines**. Still open before the phase closes: delete legacy `renderer.js`/`taskStore.js`, port the
  store tests (lane E), the architecture test (lane D), `verify:packaged`.
- **Lane C merged** (pure core: `history`, `migrate`, `capture`, `linkify`, `selectors`; 245 tests).
- **Lane B1 merged** (`main/persistence.js`, `links.js`, `lib/safeUrl.js`, `lib/titleFromHtml.js`; 121 tests).
- **Lane B2 merged**: `main.js` is now an 83-line composition root; `main/window.js` (navigation lockdown added: `setWindowOpenHandler` denies, `will-navigate` prevented — the page can never leave `index.html`), `main/tray.js`, `main/ipc.js` (the only file calling `ipcMain.*`), `main/settings.js`. `preload.js` gained `openExternal`/`fetchTitle`/`getLoadNotice`, additive only. Verified independently before merging: ownership, 208 unit tests, both Electron gates, every file read in full, channel names cross-checked by hand.
- **Lane D merged**: the architecture test (12 rules, `test/unit/lib/architecture.mjs` + `.test.mjs`), written from the plan without reading the code it checks. Its tokenizer was cross-validated against Node's bundled `acorn` over 3,495 real files before being trusted.
- **Phases 0–2 complete and merged. `PHASE = { renderer: true, main: true }`** — the architecture test now actually runs its renderer- and main-gated rules against the real tree, not just the meta-tests. It found one real thing: `main/links.js` had a local variable named `window` (its lookback buffer for a `</head>` scan) — not a DOM leak, but a name that invites the question; renamed to `scanBuf`. 660 unit tests, both Electron gates, and `verify:packaged` (the packed `.asar`) all green.
- **Phase 3 (notes in the store) already complete** (see above) — done ahead of the original sequencing since it doesn't depend on lane B.
- **Lane F merged** (its first attempt stalled before writing anything; retried as two smaller agents, F and G). F wrote 148 tests for the note operations from the spec before reading the code and found one real bug: `setBody` stored non-strings as text (`42` → `"42"`). Fixed, along with the same class of gap it found by probing: blank/non-string titles, un-normalised bodies on creation, a repeated link title re-saving, `unfileNote` keeping a stray tag. All pinned by 50 new tests, each mutation-checked (4 deliberate breaks, all caught). F also surfaced the `updatedAt` spec conflict, now resolved in section 4.
- **Lane G running**: the integrity half (ids, delete, load/save round trip, a seeded-random invariant test).

**Checkpoint reached: Phases 0–2 (and 3) are merged, green, including the packaged build. Nothing user-visible has changed — Phase 4 (the notes UI) is next and is the first phase that does.**

**How the finished pure modules are meant to be used (from the lane reports)**
- `migrate(saved)` returns a fresh object sharing no memory with its input; `null`/garbage gives the empty state,
  so `migrate(await loadThreads())` also covers "no file yet". It keeps unknown top-level fields (an older app
  must not erase what a newer one wrote) and never downgrades a version above 2. In `itemStore.loadState` use
  `Object.assign(state, migrate(saved))`, not just the four known keys, so `state` stays the same live object.
- Bare-URL link titles (4e): fetch `toHref(text.trim())`, but pass `text.trim()` itself as `url` to `setLinkTitle`
  (the "only if the text is still exactly that URL" guard compares against the trimmed text). `linkify` output is
  not normalised; main re-validates with `safeUrl` and should open `new URL(x).href`.
- `isBareUrl` is built on `linkify`, so `https://x.org.` and `https://x.org/a)` are correctly *not* bare.
- `persistence.load()` writes the backup back as the live file after a recovery (otherwise a renderer reload would
  load nothing and the next save would replace the good backup with an empty state). `save()` renames an
  unreadable live file aside before the first save of a run, and throws rather than overwrite it. Quarantine files
  never overwrite an earlier one. A file that parses but is not a state (`{"foo":1}`) must count as unreadable too:
  that is the `validate` option added in B2.
- Cache the FIRST `persistence.load()` result in `ipc.js`; a second call returns a clean result, so
  `getLoadNotice()` must derive from the cached one.
- Test helpers: `deepFreeze` is duplicated in three of lane C's test files; a shared `test/unit/_helpers.mjs`
  would remove that (cosmetic).
