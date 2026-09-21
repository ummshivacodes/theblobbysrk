// ---------- Item store ----------
// The task state machine (dump → axis → resolving → done, plus focus and history). No DOM, no
// Electron, no browser globals: it only ever touches the `persistence` and `onChange` it is handed,
// so it runs in plain Node under test (and, later, in a phone app).
//
// history = every task ever crossed off (kept after the row is deleted), so the ⚙ screen can list
// them, not just count them.
//
// persistence = { loadThreads, saveThreads }. onChange is invoked after every mutation; the app
// passes its render function.
import { toHistory } from './history.js';

export function createItemStore(persistence, onChange) {
  const state = { threads: [], stats: { listed: 0, done: 0 }, history: [] };

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

  function persist() {
    persistence.saveThreads(state);
  }

  // Capture first, tag after. A new task is untagged (quad null) and sits in the list; it only becomes
  // a thread once it is pushed onto the axis. Returns the new id so the UI can flag its row as freshly
  // added (scroll-into-view + highlight): that is presentation, so it is not part of this state.
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

  // Tagging never moves a thread by itself: Q1..Q4 is only ever a label (the paper's point: the tag
  // sets *order*, not placement). Moving between the dump and the axis is always an explicit act:
  // dispatchToAxis / recallToDump below, wired to the row's →/← buttons. Retagging works the same
  // way regardless of where the thread currently sits.
  function tagTask(id, quad) {
    const t = state.threads.find((x) => x.id === id);
    if (!t || t.status === 'resolving' || t.status === 'done') return;
    t.quad = quad;
    persist();
    onChange();
  }

  // Dump → axis. Any tagged thread can be pushed over at any quad: the tag only ever set order.
  function dispatchToAxis(id) {
    const t = state.threads.find((x) => x.id === id);
    if (!t || t.status !== 'dump') return;
    t.status = 'axis';
    persist();
    onChange();
  }

  // Axis → dump. The mirror of dispatchToAxis: for a thread you tagged and pushed over but aren't
  // actually working yet. Nothing is lost: same tag, same row, just off the axis until you push it again.
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

  // Undo a cross-off: the thread goes straight back on the axis (that is where it was when it got
  // closed) and the scoreboard gives the point back.
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

  function deleteTask(id) {
    state.threads = state.threads.filter((x) => x.id !== id);
    persist();
    onChange();
  }

  // Click an orb: single persistent focus (stored in threads.json). Clicking the focused orb again
  // clears it.
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
    loadState,
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
