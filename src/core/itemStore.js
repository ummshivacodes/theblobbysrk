// ---------- Item store ----------
// The item state machine: tasks (dump → axis → resolving → done, plus focus and history) and notes.
// No DOM, no Electron, no browser globals: it only ever touches the `persistence` and `onChange` it is
// handed, so it runs in plain Node under test (and, later, in a phone app).
//
// status is the one discriminator: 'dump' | 'axis' | 'resolving' | 'done' | 'note'. A note is never a
// half-task: it has no quad, never goes on the axis, and never counts in "listed".
//
// history = every task ever crossed off (kept after the row is deleted), so the ⚙ screen can list
// them, not just count them.
//
// persistence = { loadThreads, saveThreads }. onChange is invoked after every mutation; the app
// passes its render function. options.onSaveError(err) hears about a save that failed (disk full,
// permissions): the state is kept in memory and every later mutation saves the whole state again, so
// a failed save is retried by the next change, but it must never be silent.
//
// Every transition is guarded: an impossible move (closing a thread that is in the dump, filing a
// task that is already on the axis) does nothing: no change, no save, no redraw. Input is normalised
// here, not trusted from the caller (see cleanText / cleanBody).
import { toHistory } from './history.js';
import { migrate } from './migrate.js';

const CLOSE_BEAT_MS = 700; // how long a thread shows "crossed off" before it counts as done
const QUADS = [1, 2, 3, 4];

// The store owns the shape of its data, whoever is calling. A title is a trimmed string and never
// blank; a body is a string with its trailing whitespace trimmed, and an empty body is simply no body.
// Anything that isn't a string counts as empty (it must never be stored as "42" or "[object Object]").
const cleanText = (text) => (typeof text === 'string' ? text.trim() : '');
const cleanBody = (body) => (typeof body === 'string' ? body.replace(/\s+$/, '') : '');

export function createItemStore(persistence, onChange, { onSaveError = () => {} } = {}) {
  const state = { version: 2, threads: [], stats: { listed: 0, done: 0 }, history: [] };
  const closing = new Map(); // id → timer of a close in flight, so deleting the item can cancel it

  const find = (id) => state.threads.find((x) => x.id === id);

  // Every persisted change saves, then redraws. A failed save is reported, never swallowed and never
  // fatal: the change stays in memory and the next change saves everything again.
  function commit() {
    try {
      Promise.resolve(persistence.saveThreads(state)).catch(onSaveError);
    } catch (err) {
      onSaveError(err);
    }
    onChange();
  }

  // Timestamp ids, made unique: two items created in the same millisecond must not share an id
  // (find/delete/close would treat them as one).
  function newId() {
    const base = Date.now().toString(36);
    let id = base;
    for (let n = 1; state.threads.some((t) => t.id === id); n++) id = `${base}-${n.toString(36)}`;
    return id;
  }

  async function loadState() {
    // migrate() brings any older file to the current shape without ever dropping an item, and gives
    // the empty state for "no file yet". Assigned INTO `state`, so it stays the one live object.
    Object.assign(state, migrate(await persistence.loadThreads()));
    // A thread saved mid-close (the app quit inside the close beat) was never counted: the score and
    // history only change when the beat finishes. So put it back on the axis instead of leaving it
    // stuck in "resolving" with no timer to finish it.
    state.threads.forEach((t) => { if (t.status === 'resolving') t.status = 'axis'; });
    onChange();
  }

  // Capture first, tag after. A new task is untagged (quad null) and sits in the list. Returns the new
  // id so the UI can flag its row as freshly added (scroll-into-view + highlight): that is
  // presentation, so it is not part of this state. A blank title captures nothing and returns null.
  function addTask(text, body) {
    const title = cleanText(text);
    if (!title) return null;
    const id = newId();
    const item = { id, text: title, quad: null, status: 'dump', createdAt: Date.now() };
    const notes = cleanBody(body);
    if (notes) {
      item.body = notes;
      item.updatedAt = item.createdAt;
    }
    state.threads.push(item);
    state.stats.listed++;
    commit();
    return id;
  }

  // A note goes straight to the notes shelf. It is not a task, so it does not count as "listed". Like
  // addTask, a blank title captures nothing and returns null.
  function addNote(text, body) {
    const title = cleanText(text);
    if (!title) return null;
    const id = newId();
    const now = Date.now();
    const item = { id, text: title, quad: null, status: 'note', createdAt: now, updatedAt: now };
    const notes = cleanBody(body);
    if (notes) item.body = notes;
    state.threads.push(item);
    commit();
    return id;
  }

  // Tagging never moves a thread by itself: Q1..Q4 is only ever a label (the paper's point: the tag
  // sets *order*, not placement). Moving between the dump and the axis is always an explicit act:
  // dispatchToAxis / recallToDump below, wired to the row's →/← buttons. Retagging works the same
  // way regardless of where the thread currently sits. Notes have no tag, and a tag is one of Q1..Q4:
  // "no tag" is not something you can tag a thread with (an axis thread must always have one).
  function tagTask(id, quad) {
    const t = find(id);
    if (!t || t.status === 'resolving' || t.status === 'done' || t.status === 'note') return;
    if (!QUADS.includes(quad)) return;
    t.quad = quad;
    commit();
  }

  // Dump → axis. Any tagged thread can be pushed over at any quad: the tag only ever set order. An
  // untagged one can't (it has no order yet).
  function dispatchToAxis(id) {
    const t = find(id);
    if (!t || t.status !== 'dump' || t.quad == null) return;
    t.status = 'axis';
    commit();
  }

  // Axis → dump. The mirror of dispatchToAxis: for a thread you tagged and pushed over but aren't
  // actually working yet. Nothing is lost: same tag, same row, just off the axis until you push it again.
  function recallToDump(id) {
    const t = find(id);
    if (!t || t.status !== 'axis') return;
    t.status = 'dump';
    delete t.focused;
    commit();
  }

  // Axis → resolving (drawn crossed off at once, and saved as such only if something else saves
  // during the beat) → done, once the beat is over.
  function resolveThread(id) {
    const t = find(id);
    if (!t || t.status !== 'axis') return;
    t.status = 'resolving';
    onChange();
    closing.set(id, setTimeout(() => {
      closing.delete(id);
      t.status = 'done';
      t.doneAt = Date.now();
      delete t.focused;
      state.stats.done++;
      state.history.push(toHistory(t));
      commit();
    }, CLOSE_BEAT_MS));
  }

  // Undo a cross-off: the thread goes straight back on the axis (that is where it was when it got
  // closed) and the scoreboard gives the point back.
  function reopenTask(id) {
    const t = find(id);
    if (!t || t.status !== 'done') return;
    t.status = 'axis';
    delete t.doneAt;
    state.stats.done = Math.max(0, state.stats.done - 1);
    state.history = state.history.filter((h) => h.id !== id);
    commit();
  }

  // Dump → note. It was never really a task, so it stops being counted as one.
  function fileAsNote(id) {
    const t = find(id);
    if (!t || t.status !== 'dump') return;
    t.status = 'note';
    t.quad = null;
    t.updatedAt = Date.now();
    state.stats.listed = Math.max(0, state.stats.listed - 1);
    commit();
  }

  // Note → dump: untagged, and counted as a task again.
  function unfileNote(id) {
    const t = find(id);
    if (!t || t.status !== 'note') return;
    t.status = 'dump';
    t.quad = null; // untagged, whatever a damaged file may have left on the note
    t.updatedAt = Date.now();
    state.stats.listed++;
    commit();
  }

  // The body is free text. Trailing whitespace is trimmed; an empty body removes the key. Saving what
  // is already there changes nothing (no save, no redraw, no new edit time).
  function setBody(id, body) {
    const t = find(id);
    if (!t || t.status === 'resolving') return;
    const next = cleanBody(body);
    if (next === (t.body ?? '')) return;
    if (next) t.body = next;
    else delete t.body;
    t.updatedAt = Date.now();
    commit();
  }

  // Renaming. Blank is ignored; a crossed-off item can't be renamed. A fetched link title described
  // the OLD text, so it goes.
  function setText(id, text) {
    const t = find(id);
    if (!t || t.status === 'resolving' || t.status === 'done') return;
    const next = cleanText(text);
    if (!next || next === t.text) return;
    t.text = next;
    delete t.linkTitle;
    t.updatedAt = Date.now();
    commit();
  }

  // A page title fetched for an item whose text is a bare URL. Only applied while the text is still
  // exactly that URL: the fetch is slow and the item may have been edited or replaced meanwhile.
  function setLinkTitle(id, url, title) {
    const t = find(id);
    const clean = cleanText(title);
    if (!t || !clean || t.text.trim() !== url || clean === t.linkTitle) return;
    t.linkTitle = clean;
    t.updatedAt = Date.now();
    commit();
  }

  // Deleting a task does not shrink the lifetime counters or the crossed-off history. It does cancel a
  // close in flight, so a deleted thread can't still "complete" (and score) a moment later.
  function deleteItem(id) {
    if (!find(id)) return;
    clearTimeout(closing.get(id));
    closing.delete(id);
    state.threads = state.threads.filter((x) => x.id !== id);
    commit();
  }

  // Click an orb: single persistent focus (stored in threads.json). Clicking the focused orb again
  // clears it.
  function toggleFocus(id) {
    const t = find(id);
    if (!t || t.status !== 'axis') return;
    const wasFocused = !!t.focused;
    state.threads.forEach((x) => { delete x.focused; });
    if (!wasFocused) t.focused = true;
    commit();
  }

  return {
    state,
    loadState,
    addTask,
    addNote,
    tagTask,
    dispatchToAxis,
    recallToDump,
    resolveThread,
    reopenTask,
    fileAsNote,
    unfileNote,
    setBody,
    setText,
    setLinkTitle,
    deleteItem,
    toggleFocus,
  };
}
