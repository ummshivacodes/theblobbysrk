// ---------- Task store ----------
// The task state machine, extracted from renderer.js. No DOM, no Electron,
// no browser globals — this file only ever touches the `persistence` and
// `onChange` it is handed, so it can be unit-tested with plain Node by
// passing a fake in-memory persistence object; see the module.exports guard
// at the bottom.
//
// history = every task ever crossed off (kept after the row is deleted),
// so the gear screen can list them, not just count them.

// persistence = { loadThreads, saveThreads } — in the app this is
// window.threadAxis (the preload.js IPC bridge). onChange is invoked after
// every mutation — renderer.js passes its `render`.
function createTaskStore(persistence, onChange) {
  const state = { threads: [], stats: { listed: 0, done: 0 }, history: [] };

  // These live INSIDE the factory on purpose. index.html loads this file and
  // renderer.js as classic <script>s, which share one global lexical scope:
  // a top-level `const COLORS` here would collide with renderer.js's own
  // `COLORS` binding ("Identifier 'COLORS' has already been declared") and
  // renderer.js would fail to load at all. `createTaskStore` is deliberately
  // the only top-level name this file introduces.
  const COLORS = { 1: '#e15656', 2: '#4a86e8', 3: '#e0b23e', 4: '#9aa0a8' };
  const byCreated = (a, b) => a.createdAt - b.createdAt;
  const toHistory = ({ id, text, quad, createdAt, doneAt }) => ({ id, text, quad, createdAt, doneAt });

  // Open threads: what the blob shows, and the only threads the axis draws.
  // A thread leaves both the instant it's crossed off — closed work never
  // crowds the axis; it only lives on (struck through) in the list below.
  const activeThreads = () =>
    state.threads.filter((t) => t.status === 'axis' || t.status === 'resolving').sort(byCreated);

  async function loadState() {
    const saved = await persistence.loadThreads();
    if (saved && Array.isArray(saved.threads)) {
      state.threads = saved.threads;
      // Lifetime scoreboard. Older files have no stats: seed from what's on disk.
      state.stats = saved.stats || {
        listed: saved.threads.length,
        done: saved.threads.filter((t) => t.status === 'done').length,
      };
      // Older files have no history: seed it from the done rows still on disk.
      state.history = Array.isArray(saved.history)
        ? saved.history
        : saved.threads.filter((t) => t.status === 'done').map(toHistory);
    }
    onChange();
  }

  // Exposed alongside the actions below (not just used internally) because
  // main.js's THREAD_AXIS_SELFTEST harness patches state.stats/state.history
  // back to their pre-test values and needs to flush that correction to
  // disk itself — renderer.js's own code never calls this directly, every
  // normal mutation already persists via the action functions below.
  function persist() {
    const clean = {
      ...state,
      threads: state.threads.map(({ retagging, ...t }) => t),
    };
    persistence.saveThreads(clean);
  }

  // Capture first, tag after. A new task is untagged (quad null) and
  // sits in the list; it only becomes a thread once it gets a Q.
  // Returns the new id so renderer.js can flag its row as freshly added
  // (scroll-into-view + highlight) — that's a DOM concern, so it stays a
  // renderer.js-local `lastAddedId`, not part of this store's state.
  function addTask(text) {
    const id = Date.now().toString(36);
    state.threads.push({
      id,
      text,
      quad: null,
      status: 'dump',
      createdAt: Date.now(),
    });
    state.stats.listed++;
    persist();
    onChange();
    return id;
  }

  // Tagging never moves a thread by itself — Q1..Q4 is only ever a label
  // (the paper's point: the tag sets *order*, not placement). Moving between
  // the dump and the axis is always an explicit act: dispatchToAxis /
  // recallToDump below, wired to the row's →/← buttons. Retagging works the
  // same way regardless of where the thread currently sits.
  function tagTask(id, quad) {
    const t = state.threads.find((x) => x.id === id);
    if (!t || t.status === 'resolving' || t.status === 'done') return;
    t.quad = quad;
    t.retagging = false;
    persist();
    onChange();
  }

  // Dump → axis. Any tagged thread can be pushed over at any quad — the tag
  // only ever set order (see tagTask above).
  function dispatchToAxis(id) {
    const t = state.threads.find((x) => x.id === id);
    if (!t || t.status !== 'dump') return;
    t.status = 'axis';
    persist();
    onChange();
  }

  // Axis → dump. The mirror of dispatchToAxis: for a thread you tagged and
  // pushed over but aren't actually working yet. Nothing is lost — same tag,
  // same row, just off the axis until you push it again.
  function recallToDump(id) {
    const t = state.threads.find((x) => x.id === id);
    if (!t || t.status !== 'axis') return;
    t.status = 'dump';
    delete t.focused;
    persist();
    onChange();
  }

  function resolveThread(id) {
    const t = state.threads.find((x) => x.id === id);
    if (!t) return;
    t.status = 'resolving';
    onChange();
    setTimeout(() => {
      t.status = 'done';
      t.doneAt = Date.now();
      delete t.focused;
      state.stats.done++;
      state.history.push(toHistory(t));
      persist();
      onChange();
    }, 700);
  }

  // Undo a cross-off: the thread goes straight back on the axis (that is
  // where it was when it got closed) and the scoreboard gives the point back.
  function reopenTask(id) {
    const t = state.threads.find((x) => x.id === id);
    if (!t || t.status !== 'done') return;
    t.status = 'axis';
    delete t.doneAt;
    state.stats.done = Math.max(0, state.stats.done - 1);
    state.history = state.history.filter((h) => h.id !== id);
    persist();
    onChange();
  }

  // Note: clearing a renderer-local "hoveredId" when its thread disappears
  // is the caller's job (renderer.js does it right before calling this) —
  // hover tracking is DOM/UI state and has no business in this store.
  function deleteTask(id) {
    state.threads = state.threads.filter((x) => x.id !== id);
    persist();
    onChange();
  }

  // Click an orb: single persistent focus (stored in threads.json).
  // Clicking the focused orb again clears it.
  function toggleFocus(id) {
    const t = state.threads.find((x) => x.id === id);
    if (!t || t.status !== 'axis') return;
    const wasFocused = !!t.focused;
    state.threads.forEach((x) => { delete x.focused; });
    if (!wasFocused) t.focused = true;
    persist();
    onChange();
  }

  return {
    state,
    COLORS,
    activeThreads,
    loadState,
    persist,
    addTask,
    tagTask,
    dispatchToAxis,
    recallToDump,
    resolveThread,
    reopenTask,
    deleteTask,
    toggleFocus,
  };
}

// Browser (this app): createTaskStore is a plain global, loaded via a
// <script> tag ahead of renderer.js — no bundler, no module system.
// Node (tests): exported too, so the whole state machine can be driven with
// a fake in-memory persistence object and no DOM/Electron in the loop.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { createTaskStore };
}
