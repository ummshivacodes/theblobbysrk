# Blob: a credit line + drag-to-reorder — implementation plan

Status: **all three phases (A, B, C) done and committed. The credit line and drag-to-reorder are both live on branch `notes-reorder`, not yet merged into `main`.**
Written 2026-09-22, after Phase 5 (the notes UI) shipped. Two independent, differently-sized asks:

1. A one-line credit in the panel: **"Blob — made by SRK."** Presentational only; no plan needed
   beyond where it goes (§5). Do it whenever, in the same commit as this plan's first phase or on its own.
2. **Drag-and-drop reordering**, up or down, in the **Notes list only** — the owner scoped this down from
   "both lists" when asked ("go ahead, notes only"). The task list is unaffected: no `order` field, no
   drag handle, `inboxItems()`'s sort is untouched. Everything below that talked about the inbox group is
   kept as written (a record of the reasoning and a seam for later — see §9), but nothing under Phase B or
   C touches it.

Out of scope, stated up front so it's easy to correct: the **axis** is not reorderable by dragging. It's a
computed horizontal layout, not a list with an up/down order, and "up or down" in the ask doesn't fit it.
Reordering the ⚙ screen's crossed-off history is also out of scope: it's a log, not something you curate.

## 1. Verified / reasoned before planning

- **The render gate already tracks "pointer is down"** (`app.js`: `pointerDownAt`, `pointerHeld()`), set on
  `pointerdown` and cleared on `pointerup`/`pointercancel`. A drag is exactly `pointerdown → pointermove* →
  pointerup`, so it already holds the redraw gate for free for as long as it lasts — **except** `pointerHeld()`
  has a hard `POINTER_HOLD_MAX_MS = 5000` cap, added to stop a click that never reports its release from
  freezing the page forever. A slow, deliberate drag (someone re-reading their list while dragging) can easily
  exceed 5 seconds, and a redraw slipping through mid-drag would fight the drag exactly the way the notes work's
  redraw gate exists to prevent. **Decision: don't raise the cap; remove it for drag specifically.** A drag
  always ends in `pointerup`/`pointercancel` — the "some browser never tells us" risk the cap was guarding
  against doesn't apply to a gesture the browser itself is generating events for throughout. §4 below has the
  concrete shape.
- **The DOM's native Drag and Drop API (`draggable`, `dragstart`/`dragover`/`drop`) is the wrong tool here.**
  It hands you a browser-drawn ghost image that's fiddly to suppress/restyle, and it's a second, separate event
  model (`dragstart`/`dragover`/`drop`) alongside the `pointerdown`/`pointermove`/`pointerup` one the render gate,
  press guard and every editor already speak. Building the drag on plain pointer events instead means it plugs
  straight into what's already there instead of running two parallel gesture systems next to each other — which
  is exactly the kind of cross wire the standing rule is about. **Decision: pointer events, not native DnD.**
- **`inboxItems`/`notes` already group the app's two reorderable lists exactly right.** `inboxItems` is
  status-agnostic (dump, axis, resolving, done — every non-note item, in one visual list); `notes` is every
  note. Manual order is one field, meaningful only among items sharing one of those two groups; nothing else
  needs to change about what a "list" is.

## 2. Data model

```js
Item = {
  ...,               // unchanged
  order?: number,    // new; position within its group (inbox, or notes). Lower sorts first.
}
```

- `order` is only ever compared against other items in the **same group** (inbox vs. notes); there's no
  cross-group meaning; a task's `order` is stale and unused the moment it becomes a note (`fileAsNote`), and a
  fresh one is assigned the moment it needs one again (see below).
- **Migration backfills it losslessly and invisibly.** `migrate.js` gains one step: for the inbox group and the
  notes group, separately — if every member already has a finite numeric `order`, leave the group alone.
  Otherwise, re-number the **whole group** `0, 1, 2, …` in **today's natural order** (createdAt ascending for
  inbox; newest-edited-first for notes). So loading an old file changes nothing anyone sees until they actually
  drag something — the same "a phase that touches the schema changes no behaviour" discipline the notes plan
  used for its own Phases 0–2.
  - This needs the exact grouping/sort rules `selectors.js` already has (`isNote`, `byCreatedAsc`,
    `newestEditFirst`), and `migrate.js` must not reimplement them a second time — that's the two-places-one-
    rule cross wire the standing rule exists to catch. **New tiny core file, `src/core/naturalOrder.js`**,
    exports `isNote`, `byCreatedAsc`, `newestEditFirst`; `selectors.js` is refactored to import them instead of
    keeping its own private copies (a no-behaviour-change refactor, its own commit, gated by the existing
    selectors tests staying green with zero changes); `migrate.js` imports the same ones for the backfill.
- **A new note gets the position a fresh note always had: the top.** Corrected during implementation — the
  plan's first draft said "the end of the group", copying the INBOX list's convention (new task = bottom, since
  that list sorts oldest-created-first). Notes sort newest-edited-first by default, so a brand-new note has
  always appeared at the top; keeping that on `addNote` and `fileAsNote` means the switch to manual order is
  truly invisible until you drag something, exactly as intended. Concretely: `order = min(existing note
  orders, defaulting to 0) - 1`. `unfileNote` (note → task) drops `order` entirely — it means nothing outside
  the notes group, the same way `fileAsNote` already drops `quad` when a task becomes a note.

## 3. The store: one new transition

```js
reorderItems(orderedIds)
```
Guarded like every other transition (a bad call is a no-op, no save, no redraw):
- `orderedIds` must be an array of strings.
- Look up the items for those ids. They must all exist, all belong to the **same** group (all non-notes, or
  all notes — never mixed), and the set must be **exactly** the current full membership of that group: no
  missing id, no extra one, no duplicate. (Simpler and safer than a partial reorder — the caller always has
  the full current list in hand anyway, since it just finished dragging within it.)
- On success: `order = index` for each id in the given sequence, one `commit()` (one save, one redraw) — same
  shape as every other mutator in `itemStore.js`.
- Unit-tested the same way the rest of the store is: the happy path (and its exact reverse), a stale/mismatched
  id set (in particular a note deleted mid-drag — the drop handler's captured list is now stale, and must be
  rejected rather than half-applied), an id belonging to a task, a duplicate id, and an empty array (a true
  no-op: "reorder nothing" is not a move) — each confirmed by a mutation test that the guard it targets is
  actually load-bearing.

`selectors.js`'s `inboxItems`/`notes` sort by `order` ascending (falling back to today's comparator — `byCreatedAsc` /
`newestEditFirst` — for the tie-break, and for any item that somehow still lacks one, which should only ever be
possible for a moment before a group's first-ever backfill).

**Decided:** notes only (see the top of this plan). `notes()`'s "newest edited first" default now only applies
until the first drag — after that, order is manual and sticky (editing a note no longer moves it), the same way
tagging a task doesn't auto-move it on the axis. Confirmed in Phase B: the Phase 4 notes test had one assertion
that assumed the old behaviour ("editing a note moves it to the top"); it now asserts the opposite, with a
comment explaining why — the same kind of deliberate, documented change `ui.electron.js` got exactly once for
the `version` field.

## 4. The render gate and press guard need one more "is something going on" signal

`app.js` already asks two things before it will draw: `pointerHeld()` and `editingBody()`. Dragging adds a
third, from a new generic controller (§5): `anyListIsDragging()`. All three fold into the one `isHeld` check
the gate already takes — nothing about the gate itself changes, it just gets a longer list of reasons to wait.
The press guard's `isEditing` callback should likewise become "is editing OR dragging", since starting a drag
on one row while a rename/note-edit is open elsewhere on the SAME kind of `mousedown`-must-not-steal-focus
question the press guard already exists to answer (a drag handle is not a text field, so the mousedown-inside-
a-textarea exemption still applies correctly either way).

Concretely (shape, not final code): `pointerHeld()` stays exactly as it is for a plain click (5 s cap kept,
still guards against the "never reports release" case), and `anyListIsDragging()` is a **separate, uncapped**
signal — a drag holds the gate for exactly as long as it is a drag, however long that is, and the cap that
protects against a stuck click has no reason to apply to a gesture with its own definite end.

## 5. UI spec

- A small drag handle (not the whole row — the row already does other things on click: focus, expand, rename)
  appears at the **end** of a row, visible on hover, matching how the existing controls only show their
  affordance on interaction. A plausible glyph: `⠿` or `⋮⋮`, styled like the `.task-act` buttons' quiet
  background-on-hover treatment, not competing with them.
- Press and drag the handle: the row lifts (subtle scale + shadow, in the same visual language as the axis's
  existing `hovered`/`raise` treatment), the list makes room with a slim placeholder where it would land if
  released now, and the other rows animate out of the way — no full redraw during this; it is all handled by
  the drag controller repositioning DOM nodes directly, the same way the axis already re-keys and transform-
  slides its `<g>` elements across a render rather than rebuilding them.
- Release: the placeholder's position becomes the new order; `actions.reorder(orderedIds)` fires once.
- **While the Notes screen's search box has anything typed in it, dragging is disabled** (no handle shown):
  reordering a filtered subset doesn't have a sensible meaning (what does "move to position 2" mean when six
  items are hidden?). Clear the search to drag again.
- Esc while dragging cancels it (puts the row back where it started, fires nothing) — the same "the in-flight
  gesture, not the panel, hears Esc first" rule the body editor and title editor already follow.

## 6. New/changed files

```
src/core/naturalOrder.js     NEW. isNote, byCreatedAsc, newestEditFirst — extracted from selectors.js
src/core/selectors.js        import naturalOrder instead of its own private copies; no behaviour change
src/core/migrate.js          backfill `order` per group, losslessly, as above
src/core/itemStore.js        + reorderItems(orderedIds); addTask/addNote/unfileNote assign order = end-of-group
src/ui/dragList.js           NEW. Generic pointer-based drag controller for a vertical list of rows: knows
                              nothing about tasks/notes/the store — takes a container and onReorder(ids), the
                              same "generic controller, callbacks in" shape as renderGate.js/pressGuard.js/
                              screens.js. Exposes isDragging() for app.js's isHeld/isEditing checks.
src/ui/views/itemRow.js      the drag handle; handlers gains reorder-related wiring only insofar as the row
                              needs to expose itself to the drag controller (a data attribute/ref), not a new
                              per-row action — the controller reads the DOM directly, same as the axis view
                              already keys its bars by data-id
src/ui/app.js                wires dragList into both lists, folds isDragging() into the gate/press-guard
styles/notes.css (or a        the handle, the lifted-row look, the placeholder — a new small section, same
  new styles/reorder.css)     file-per-feature convention as notes.css itself
index.html                   the credit line, in the ⚙ screen, after the "Toggle Blob ⌘⇧Y" row:
                              <div class="credit">Blob — made by SRK</div>
test/unit/naturalOrder.test.mjs, an extended itemStore.test.mjs (reorderItems), an extended migrate test
  (backfill), an extended selectors test (sorts by order once present)
test/app/reorder.electron.js  NEW (own file, so ui.electron.js and notes.electron.js both stay exactly as they
                              are). npm run test:reorder; verify and verify:packaged grow to include it, same
                              as test:notes was threaded in for Phase 4.
```

No file here needs anything the architecture test's view allow-list doesn't already permit, **except**
`dragList.js` itself: it's a new `src/ui/*.js` (not `src/ui/views/*`) generic controller, so it sits alongside
`panel.js`/`renderGate.js`/`pressGuard.js` — nothing to extend in `VIEW_ALLOWED_IMPORTS`, since views importing
it is not a thing (only `app.js` constructs and wires it, exactly like the render gate).

## 7. Phases (each ends green and committed; the credit line can ride with A or stand alone)

| Phase | What | Gate |
|---|---|---|
| **A. Credit line** | The one `<div>` + a couple of lines of CSS. | Existing suites unchanged and green; one new check in `test/app/reorder.electron.js` (or wherever it lands) confirming the text is there. |
| **B. Store + migration, no UI change** | `naturalOrder.js` extraction (§2), migration backfill, `reorderItems`, `order` assignment on `addTask`/`addNote`/`unfileNote`, selectors sort by `order`. | `npm run verify` green; **`ui.electron.js` and `notes.electron.js` both unchanged and green** (nothing about this phase is visible — same discipline as the notes plan's Phases 0–2). |
| **C. The drag UI** | `dragList.js`, the handle, the gate/press-guard signal, the styling, wiring in `app.js` for both lists. | `npm run verify` green, `test/app/reorder.electron.js` covers: drag reorders and persists; a redraw elsewhere while dragging doesn't fight the drag (the exact class of bug 4a's redraw gate was built for — write this test from this plan's §4, before reading the implementation, the way lane F/G did for the notes store); a drag lasting past 5 s doesn't get pre-empted by the old click cap; Esc cancels; search hides the handle; the file on disk has no extra fields beyond `order`. |

## 8. Testing notes (carried over from Phase 4's hard-won lessons — see `docs/NOTES-PLAN.md` §11)

- Real (trusted) pointer events for the drag itself (`webContents.sendInputEvent` with a `mouseMove` sequence,
  not a synthetic `dragstart`) — synthetic events can't reproduce a real gesture's timing, which is exactly
  what this feature's riskiest edge case (§4, the 5 s cap) is about.
- Seal the test window at creation, own the show/hide events, swallow stray real hover events, wrap the driver
  so a page-side throw carries its message out, start every section with a "is the panel still open" tripwire —
  all already written down in `docs/NOTES-PLAN.md` §11 point 1–2, 6, 8. Reuse them; don't rediscover them.
- Run each Electron test once, twice at most, per change. Don't loop chasing a flake — get one trace, fix the
  cause, move on.

## 9. Deferred, and where it would plug in

| Later | Plugs in at | Why it's not blocked by this plan |
|---|---|---|
| Keyboard reordering (move up/down without a mouse, for accessibility) | `dragList.js` gains a keyboard path that calls the same `onReorder` | The store's `reorderItems` doesn't know or care how the new order was decided |
| Reordering within a filtered Notes search | Would need `order` to mean something about a subsequence, not just the whole group | Deliberately simpler for now (§5); revisit if it turns out to matter in daily use |
| The axis, reorderable | A different, harder problem (it's a computed layout, not a list) | Out of scope by this plan's own first paragraph |

## 10. Progress log

**2026-09-22**
- **Phase A done:** the `.credit` line in the ⚙ screen (`styles/credit.css`, its own tiny file — not `style.css`,
  which stays the original screen's styles, and not `notes.css`, which isn't what this is either). One check
  added to `test/app/notes.electron.js`.
- **Phase B done** (branch `notes-reorder`): `naturalOrder.js` extracted from `selectors.js` (no-behaviour-change,
  confirmed by the existing selectors/migrate tests passing unchanged before any new behaviour was added);
  `migrate.js`'s `seedNoteOrder` backfill; `selectors.js`'s `notes()` sorts by manual order with a
  newest-edited-first fallback; `itemStore.js` gains `reorderItems` (guarded, mutation-tested) and assigns/drops
  `order` on `addNote`/`fileAsNote`/`unfileNote`. `npm run verify` green (1,108 unit tests; both Phase-0 and Phase
  4 Electron tests green — the latter with two deliberate, documented changes: editing a note no longer reorders
  the list, and `order` is a known field). Corrected while implementing: a new note lands at the TOP of the
  group (matching what "newest edited first" always did for a fresh note), not the bottom — the plan's first
  draft got this backwards by copying the (unbuilt) inbox list's convention; see §2.
- **Phase C done: the drag UI.** `src/ui/dragList.js` — plain pointer events (pointerdown/move/up/cancel), not the
  browser's native drag-and-drop, so it shares the render gate and press guard instead of running a second gesture
  system beside them. It is constructed and owned by `app.js`, watching the Notes list's container directly — NOT
  imported by `notesView.js`. The first attempt had it the other way round, and the architecture test's R2 rule
  (views may import only the allow-listed files) correctly rejected it: `dragList` is cross-cutting app machinery
  like `panel`/`renderGate`/`pressGuard`, not a view's own sibling module like `bodyEditor`/`titleEditor`. The gate's
  5 s click-safety cap (§1/§4) does NOT protect a drag — `noteDrag.isDragging()` is a separate, uncapped signal, and
  the test holds a drag open for 5.6 s to prove it. `test/app/reorder.electron.js` + `npm run test:reorder`, threaded
  into `verify`/`verify:packaged`. Building the test surfaced a real, general testing gotcha, now in
  `docs/NOTES-PLAN.md` §11 point 10 (a `getBoundingClientRect()` read racing Chromium's own layout pass right after
  something else changed the DOM) — not a bug in the app, but worth any future test knowing about.
- **Not done, deliberately: the "rename can repaint from a stale snapshot" question from the Phase 5 review.** The
  SAME class of local-`redraw()`-bypasses-the-gate mechanism exists here too (`toggleExpand`/`startRename`/
  `endRename` in `notesView.js`), but a real single-pointer drag cannot coincide with a click on a DIFFERENT row's
  button (the mouse is captured by the drag handle) the way the earlier finding's scenario needed two clicks in
  quick succession — so this is even less reachable than that one, and was not chased for the same reason: fixing
  it needs a real scenario to test against, and none exists here.
- **Not merged into `main` yet.** `npm run verify` is green (1,108 unit tests; all four Electron suites). Whoever
  merges this should run the same read-only reviewer-agent audit Phase 5 used before merging Phase 4, since nobody
  has looked at this tree with fresh eyes yet.

