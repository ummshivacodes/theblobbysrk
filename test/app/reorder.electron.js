// Black-box test of drag-to-reorder on the Notes screen (docs/REORDER-PLAN.md). Like test/app/notes.electron.js
// it drives the REAL DOM of the REAL main process on fixture data, never touches your real threads.json
// (scripts/lib/isolatedApp.js), and reuses every lesson logged in docs/NOTES-PLAN.md §11: the window is sealed
// off from you (can't take keyboard focus, ignores your real mouse), the show/hide events the page reacts to
// are sent by the test itself, real stray mouseenter/mouseleave events are swallowed and counted, and the
// driver's errors carry the failing action's name and the real page-side message.
//
//   npm run test:reorder
//
// Needs a GUI session; ~20 s (one check deliberately holds a drag open past 5 seconds — see below). Don't
// type while it runs, and don't loop it: one run per change, two at most.
const { app: electronApp } = require('electron');
const { bootIsolatedApp } = require('../../scripts/lib/isolatedApp.js');
const { sleep, waitFor, createReporter } = require('./harness.js');

let sendToPage;
electronApp.on('browser-window-created', (event, w) => {
  w.setFocusable(false);
  w.setIgnoreMouseEvents(true);
  sendToPage = w.webContents.send.bind(w.webContents);
  w.webContents.send = (channel, ...args) => {
    if (channel === 'window-shown' || channel === 'window-hidden') return; // the test sends these itself
    sendToPage(channel, ...args);
  };
});
const lifecycle = (channel) => sendToPage(channel);

const T = 1700000000000;
const ctx = bootIsolatedApp({
  fixture: {
    version: 2,
    threads: [
      { id: 'n1', text: 'first note', quad: null, status: 'note', createdAt: T + 1, updatedAt: T + 1, order: 0 },
      { id: 'n2', text: 'second note', quad: null, status: 'note', createdAt: T + 2, updatedAt: T + 2, order: 1 },
      { id: 'n3', text: 'third note', quad: null, status: 'note', createdAt: T + 3, updatedAt: T + 3, order: 2 },
      { id: 'n4', text: 'fourth note', quad: null, status: 'note', createdAt: T + 4, updatedAt: T + 4, order: 3 },
      { id: 'task1', text: 'a plain task', quad: 1, status: 'dump', createdAt: T + 5 },
    ],
    stats: { listed: 1, done: 0 },
    history: [],
  },
});
const { app, BrowserWindow } = ctx;
const rep = createReporter({ app, cleanup: ctx.cleanup });
const { check, expectEq } = rep;
const finish = () => rep.finish();

// ---------------------------------------------------------------------------------------------
// Runs IN THE PAGE. DOM only: it must not touch anything the app defines.
// ---------------------------------------------------------------------------------------------
function pageDriver() {
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const need = (el, what) => { if (!el) throw new Error(`no such element: ${what}`); return el; };
  const fire = (el, type, init = {}) => el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, ...init }));
  const rowEl = (id) => need($(`#noteList .task-row[data-id="${id}"]`), `note row "${id}"`);

  // The test owns hovering (see notes.electron.js's §11 note 2): swallow every real (trusted)
  // mouseenter/mouseleave before the app ever sees it, and count them for the record.
  const strayHovers = [];
  ['mouseenter', 'mouseleave'].forEach((type) => document.addEventListener(type, (e) => {
    if (!e.isTrusted) return;
    strayHovers.push(type);
    e.stopImmediatePropagation();
  }, true));


  function snapshot() {
    const order = $$('#noteList .task-row').map((r) => r.dataset.id);
    return {
      ready: document.documentElement.dataset.ready === '1',
      hasFocus: document.hasFocus(),
      panelOpen: $('#panel').classList.contains('open'),
      panelDisplay: $('#panel').style.display,
      panelSettled: $('#panel').offsetHeight >= $('.panel-inner').offsetHeight,
      screen: $('#notesScreen').classList.contains('active') ? 'notes' : $('#mainScreen').classList.contains('active') ? 'main' : '?',
      order,
      text: order.map((id) => $('.task-text', rowEl(id)).textContent.trim()),
      dragging: order.map((id) => rowEl(id).classList.contains('dragging')),
      anyDragging: !!$('#noteList .task-row.dragging'),
      handleShown: order.map((id) => !!$('.drag-handle', rowEl(id))),
      rename: $('.title-edit') ? { value: $('.title-edit').value, focused: document.activeElement === $('.title-edit') } : null,
      // A different row's body, whichever mode it is currently in, so a drag elsewhere can be checked not to
      // disturb it: mid-drag it should stay in edit mode with the caret in it; once a deferred redraw finally
      // catches up (after the drag ends), it is expected to settle into read mode showing the saved text.
      otherBody: $('.body-edit') ? { mode: 'edit', value: $('.body-edit').value, focused: document.activeElement === $('.body-edit') }
        : $('.body-read') ? { mode: 'read', value: $('.body-read').textContent }
          : null,
      taskRow: $('#taskList .task-row[data-id="task1"]')
        ? { hasHandle: !!$('.drag-handle', $('#taskList .task-row[data-id="task1"]')) } : null,
    };
  }

  const actions = {
    snapshot,
    strayHovers: () => strayHovers,
    hoverShell: (on) => { fire($('#shell'), on ? 'mouseenter' : 'mouseleave'); return snapshot(); },
    click: (sel) => { need($(sel), sel).click(); return snapshot(); },
    search: (value) => {
      const box = $('#notesSearch');
      box.value = value;
      box.dispatchEvent(new Event('input', { bubbles: true }));
      return snapshot();
    },
    expander: (id) => { need($('.row-expander', rowEl(id)), 'expander').click(); return snapshot(); },
    type: (id, value) => {
      const area = need($('.body-edit', rowEl(id)), 'body editor');
      area.value = value;
      area.dispatchEvent(new Event('input', { bubbles: true }));
      return snapshot();
    },
    blurActive: () => { if (document.activeElement) document.activeElement.blur(); return snapshot(); },
    // Where to aim a real pointer: the handle of a given row, a touch left of its centre (consistent with
    // the notes test's own aiming rule) so it never lands on a scrollbar.
    handleAt: (id) => new Promise((resolve) => requestAnimationFrame(() => {
      const handle = need($('.drag-handle', rowEl(id)), `handle for "${id}"`);
      handle.scrollIntoView({ block: 'nearest' });
      const r = handle.getBoundingClientRect();
      const x = Math.round(r.left + r.width / 2 - 2);
      const y = Math.round(r.top + r.height / 2);
      const under = document.elementFromPoint(x, y);
      resolve({ x, y, hits: !!under && handle.contains(under) });
    })),
    // The vertical midpoint of a row, for aiming a drag's intermediate moves. Waits a frame first: called
    // right after something else changed the DOM (a different row's editor was just typed into, say), the
    // rect must reflect the settled layout, not whatever Chromium had before that change was painted.
    midpointOf: (id) => new Promise((resolve) => requestAnimationFrame(() => {
      const r = rowEl(id).getBoundingClientRect();
      resolve({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) });
    })),
    pageKey: (key) => { document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })); return snapshot(); },
    // Renaming: double-click a title, type into the box that appears, press a key in it.
    dblclick: (id) => { fire($('.task-text', rowEl(id)), 'dblclick'); return snapshot(); },
    renameType: (id, value) => {
      const box = need($('.title-edit', rowEl(id)), 'title editor');
      box.value = value;
      box.dispatchEvent(new Event('input', { bubbles: true }));
      return snapshot();
    },
    renameKey: (id, key, init = {}) => {
      need($('.title-edit', rowEl(id)), 'title editor').dispatchEvent(
        new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }));
      return snapshot();
    },
  };

  window.__reorder = Object.fromEntries(Object.entries(actions).map(([name, fn]) => [name, async (...args) => {
    try { return await fn(...args); } catch (e) { return { __error: e.message }; }
  }]));
}

// ---------------------------------------------------------------------------------------------
// Runs here, in the main process.
// ---------------------------------------------------------------------------------------------
let win;
let last = null;
let lastPollError = null;

const act = async (name, ...args) => {
  const result = await win.webContents.executeJavaScript(
    `window.__reorder[${JSON.stringify(name)}](...${JSON.stringify(args)})`);
  if (result && result.__error) throw new Error(`${name}(${args.map((a) => JSON.stringify(a)).join(', ')}): ${result.__error}`);
  return result;
};
async function until(pred, ms = 5000) {
  const ok = await waitFor(async () => {
    try { last = await act('snapshot'); return pred(last); } catch (e) { lastPollError = e.message; throw e; }
  }, ms);
  if (ok) lastPollError = null;
  return ok ? last : null;
}
const brief = (s) => s && JSON.stringify({ panelOpen: s.panelOpen, screen: s.screen, order: s.order });
const why = (s) => (s ? '' : `timed out; last seen ${brief(last)}${lastPollError ? `; last error: ${lastPollError}` : ''}`);

const disk = () => ctx.readData();
const untilDisk = (pred, ms = 4000) => waitFor(() => pred(disk()), ms);
const orderOnDisk = (id) => disk().threads.find((t) => t.id === id).order;

async function panelStillOpen(where) {
  const s = await act('snapshot');
  if (s.panelOpen && s.panelDisplay === 'block') return true;
  check(`(setup) the panel is still open before ${where}`, false, brief(s));
  await act('hoverShell', true);
  await until((x) => x.panelOpen && x.panelDisplay === 'block' && x.panelSettled);
  return false;
}

// A real drag: move to the handle, press, move through each named row IN TURN (so the algorithm sees every
// midpoint it needs to, not just the final point), release. `holdMs` between moves — real trusted events, per
// the notes test's own §11 lesson: synthetic ones cannot reproduce a real gesture's timing.
// A few pixels past a row's exact vertical midpoint, in the direction of travel: the algorithm's own
// decision (dom.js's targetRef) is a `<` comparison against that midpoint, and aiming exactly AT it —
// what a naive test would do — leaves the outcome riding on sub-pixel rounding between the test's
// rounded aim and the live, unrounded getBoundingClientRect() the app compares against. Every drag in
// this file moves downward through its `viaIds`, so "past" always means a little further down.
const PAST_MIDPOINT_PX = 6;

async function dragTo(fromId, viaIds, holdMs = 60) {
  const wc = win.webContents;
  const start = await act('handleAt', fromId);
  let at = start;
  wc.sendInputEvent({ type: 'mouseMove', x: at.x, y: at.y });
  wc.sendInputEvent({ type: 'mouseDown', x: at.x, y: at.y, button: 'left', clickCount: 1 });
  await sleep(holdMs);
  for (const id of viaIds) {
    const mid = await act('midpointOf', id);
    at = { x: mid.x, y: mid.y + PAST_MIDPOINT_PX };
    wc.sendInputEvent({ type: 'mouseMove', x: at.x, y: at.y });
    await sleep(holdMs);
  }
  return { release: () => {
    wc.sendInputEvent({ type: 'mouseUp', x: at.x, y: at.y, button: 'left', clickCount: 1 });
  } };
}

app.whenReady().then(async () => {
  win = BrowserWindow.getAllWindows()[0];
  if (win.webContents.isLoading()) await new Promise((r) => win.webContents.once('did-finish-load', r));
  await win.webContents.executeJavaScript(`(${pageDriver.toString()})()`);
  win.webContents.debugger.attach('1.3');
  await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });

  let s = await until((x) => x.ready, 12000);
  if (!check('boots and draws the saved state', !!s, why(s))) return finish();
  lifecycle('window-shown');
  await sleep(700); // the app's own late-focus-the-capture-box behaviour on first show; let it settle
  await act('click', '#notesBtn');
  s = await until((x) => x.screen === 'notes' && x.panelSettled);
  if (!check('the Notes screen opens, settled', !!s, why(s))) return finish();
  check('the page counts as focused (needed below)', s.hasFocus);
  expectEq('starts in the order the fixture gave (no drag has happened yet)', s.order, ['n1', 'n2', 'n3', 'n4']);
  check('every note shows a drag handle; the task list does not', s.handleShown.every(Boolean) && s.taskRow && !s.taskRow.hasHandle);

  // ---- a real drag reorders and persists --------------------------------------------------------------
  await panelStillOpen('the first drag');
  let drag = await dragTo('n1', ['n2', 'n3']); // drag the first note down past the second and third
  s = await act('snapshot');
  check('while held, the dragged row is marked .dragging', s.dragging[s.order.indexOf('n1')]);
  drag.release();
  s = await until((x) => x.order.join() === ['n2', 'n3', 'n1', 'n4'].join());
  check('dropping it there reorders the list', !!s, why(s));
  check('…and it is not still marked dragging', !s.dragging.some(Boolean));
  check('…saved as the new order, and nothing else about the notes changed', await untilDisk((d) => {
    const byId = Object.fromEntries(d.threads.map((t) => [t.id, t]));
    return byId.n2.order === 0 && byId.n3.order === 1 && byId.n1.order === 2 && byId.n4.order === 3
      && byId.n1.text === 'first note';
  }), JSON.stringify(disk().threads.map((t) => [t.id, t.order])));

  // ---- dropping back where it started is not a move (no save) --------------------------------------------
  const stampBefore = orderOnDisk('n2');
  drag = await dragTo('n2', ['n2']); // pick it up and put it straight back down
  drag.release();
  s = await until((x) => !x.dragging.some(Boolean));
  check('picking a row up and putting it back where it was is not a move', !!s && s.order.join() === ['n2', 'n3', 'n1', 'n4'].join(), why(s));
  check('…nothing was saved for it', !(await waitFor(() => orderOnDisk('n2') !== stampBefore, 400)));

  // ---- Esc cancels: the row goes back, nothing is saved -----------------------------------------------------
  drag = await dragTo('n2', ['n3', 'n1']);
  s = await act('snapshot');
  check('(setup) mid-drag, the order looks different', s.order.join() !== ['n2', 'n3', 'n1', 'n4'].join(), s.order.join());
  await act('pageKey', 'Escape');
  s = await until((x) => x.order.join() === ['n2', 'n3', 'n1', 'n4'].join());
  check('Esc cancels: the row goes back exactly where it was', !!s, why(s));
  check('…and does not also leave the Notes screen or fold the panel', s.screen === 'notes' && s.panelOpen);
  drag.release(); // let go of the now-irrelevant real mouse button

  // ---- dragging is off while a search is showing ------------------------------------------------------------
  s = await act('search', 'first');
  check('searching hides every drag handle', s.handleShown.length > 0 && s.handleShown.every((h) => !h), JSON.stringify(s.handleShown));
  await act('search', '');
  s = await act('snapshot');
  check('clearing the search brings the handles back', s.handleShown.every(Boolean));

  // ---- dragging one row does not disturb an editor open on ANOTHER ---------------------------------------------
  await act('expander', 'n3');
  s = await until((x) => x.otherBody && x.otherBody.focused);
  check('(setup) editing the body of a different note', !!s, why(s));
  await act('type', 'n3', 'typing while something else gets dragged');
  drag = await dragTo('n1', ['n4']);
  s = await act('snapshot');
  check('mid-drag, the OTHER row\'s open editor still has the caret and the words typed into it',
    s.otherBody && s.otherBody.focused && s.otherBody.value === 'typing while something else gets dragged');
  drag.release();
  s = await until((x) => x.order.join() === ['n2', 'n3', 'n4', 'n1'].join());
  check('…and the drag still completed correctly', !!s, why(s));
  check('…the edit was saved (autosave does not wait on the drag: only the SCREEN update does)',
    await untilDisk((d) => d.threads.find((t) => t.id === 'n3').body === 'typing while something else gets dragged'));
  await act('blurActive');
  await act('expander', 'n3'); // collapse it again

  // ---- the risk this whole feature was designed around: a drag lasting past the OLD 5s click-safety cap ----------
  // A drag alone never proves this: nothing else is asking to redraw, so there is nothing for the old cap to
  // let slip through. Something else has to WANT a redraw partway through the long hold. A synthetic click
  // opening a different row's editor mid-drag would not be realistic here — a real drag captures the mouse,
  // so a person cannot also click a different row's expander with the same pointer. What IS realistic: the
  // editor was already open and being typed into (one hand on the mouse to drag, the other still on the
  // keyboard, or simply an autosave timer from before the drag started firing during it) — so open it and
  // type FIRST, then start the drag.
  await act('expander', 'n4');
  s = await until((x) => x.otherBody && x.otherBody.focused);
  check('(setup) a different note\'s (empty) body editor is open, caret in it', !!s, why(s));
  await act('type', 'n4', 'edited during the long hold');
  await panelStillOpen('the slow drag');
  drag = await dragTo('n2', ['n3']);
  await sleep(5600); // past POINTER_HOLD_MAX_MS: if the drag relied on that cap, the screen would break here
  s = await act('snapshot');
  check('past 5 seconds, the dragged row is STILL marked dragging: nothing snuck a redraw through',
    s.dragging[s.order.indexOf('n2')], JSON.stringify(s));
  check('…the other note\'s edit is still exactly as typed, uninterrupted, the whole time',
    s.otherBody && s.otherBody.value === 'edited during the long hold' && s.otherBody.focused);
  check('…and that edit reached disk on its own schedule regardless (autosave, not the screen)',
    await untilDisk((d) => d.threads.find((t) => t.id === 'n4').body === 'edited during the long hold'));
  drag.release();
  s = await until((x) => x.order.join() === ['n3', 'n2', 'n4', 'n1'].join());
  check('…releasing the drag after all that time still completes it correctly', !!s, why(s));
  check('…both the reorder and the earlier edit are reflected once the screen finally catches up',
    !!s && s.otherBody && s.otherBody.value === 'edited during the long hold');
  check('…saved correctly', await untilDisk((d) => {
    const byId = Object.fromEntries(d.threads.map((t) => [t.id, t]));
    return byId.n3.order === 0 && byId.n2.order === 1 && byId.n4.order === 2 && byId.n1.order === 3;
  }), JSON.stringify(disk().threads.map((t) => [t.id, t.order])));
  await act('blurActive');
  await act('expander', 'n4');

  // ---- ending a DIFFERENT row's rename with Enter, mid-drag, must not rebuild the list out from under it ----
  // Found by a Phase-5-style reviewer audit (2026-09-22), against the plan's own ("even less reachable than
  // the rename-vs-rename finding") reasoning: a real single pointer can't click two rows, but one hand can
  // still drag with the mouse while the other ends an already-open rename with Enter — an entirely ordinary
  // two-handed action, not a second input device. Order entering this section: n3, n2, n4, n1.
  await act('dblclick', 'n1');
  s = await until((x) => x.rename && x.rename.focused);
  check('(setup) renaming n1 (last in the list), caret in the box', !!s, why(s));
  await act('renameType', 'n1', 'renamed while n2 drags');
  drag = await dragTo('n2', ['n4']); // a different row entirely
  s = await act('snapshot');
  check('(setup) n2 is mid-drag while n1 is mid-rename, at the same time', s.dragging[s.order.indexOf('n2')] && s.rename && s.rename.value === 'renamed while n2 drags');
  s = await act('renameKey', 'n1', 'Enter'); // the other hand, on the keyboard
  check('n2\'s drag is UNDISTURBED by ending n1\'s rename: still marked dragging, not rebuilt out from under it',
    s.dragging[s.order.indexOf('n2')], JSON.stringify(s));
  check('…n1\'s edit is not lost — it is just not repainted yet (the list redraw is held back by the drag)',
    s.rename && s.rename.value === 'renamed while n2 drags' && !s.rename.focused, JSON.stringify(s.rename));
  drag.release();
  s = await until((x) => x.rename === null && x.order.join() === ['n3', 'n4', 'n2', 'n1'].join());
  check('once the drag ends, the held-back rename-end catches up: plain text, in the right place', !!s, why(s));
  check('…reading the new title', !!s && s.text[s.order.indexOf('n1')] === 'renamed while n2 drags', why(s));
  check('…both changes saved: the rename and the reorder', await untilDisk((d) => {
    const byId = Object.fromEntries(d.threads.map((t) => [t.id, t]));
    return byId.n1.text === 'renamed while n2 drags' && byId.n3.order === 0 && byId.n4.order === 1 && byId.n2.order === 2 && byId.n1.order === 3;
  }), JSON.stringify(disk().threads.map((t) => [t.id, t.text, t.order])));

  // ---- the window being hidden mid-drag (the global hotkey can fire regardless of focus) cancels it cleanly ----
  // Defence in depth: app.js calls noteDrag.cancel() before collapsing, rather than relying on Electron/the
  // OS to interrupt the pointer stream on its own when a window is hidden.
  await act('hoverShell', true);
  s = await until((x) => x.panelOpen && x.panelSettled);
  if (!check('(setup) the panel is open', !!s, why(s))) return finish();
  const beforeHide = s.order.join();
  drag = await dragTo('n4', ['n2']);
  s = await act('snapshot');
  check('(setup) a drag is in progress', s.anyDragging, JSON.stringify(s));
  lifecycle('window-hidden'); // what main sends when the hotkey (or anything else) hides the window
  s = await until((x) => !x.panelOpen);
  check('the panel collapses as it always does when the window is hidden', !!s, why(s));
  check('…and the drag was cancelled, not left stuck: no row is marked dragging', !s.anyDragging, JSON.stringify(s));
  check('…the row went back where it was — cancelling is exactly like Esc, not a move', s.order.join() === beforeHide, s.order.join());
  drag.release(); // the real mouse button the OS/Electron doesn't know is now irrelevant
  lifecycle('window-shown');
  await act('hoverShell', true);
  s = await until((x) => x.panelOpen && x.panelSettled);
  if (!check('(setup) back open', !!s, why(s))) return finish();
  // Hiding collapsed the panel, which (like Esc) also steps back to the main screen — reopen Notes
  // before trying another drag there.
  await act('click', '#notesBtn');
  s = await until((x) => x.screen === 'notes');
  if (!check('(setup) the Notes screen is showing again, for one more real drag to prove nothing is left stuck', !!s, why(s))) return finish();
  drag = await dragTo('n1', ['n3']);
  drag.release();
  s = await until((x) => x.order.join() !== beforeHide);
  check('a fresh drag afterwards still works normally: nothing about the render gate stayed stuck "held"', !!s, why(s));

  // ---- leaving the screen mid-drag is not something a person can normally do, but make sure the app is left sane
  await act('pageKey', 'Escape');
  s = await until((x) => x.screen === 'main');
  check('(setup) Esc (no drag in progress now) returns to the main screen as always', !!s, why(s));

  const stray = await act('strayHovers');
  if (stray.length) console.log(`note: ${stray.length} real mouseenter/mouseleave event(s) reached the sealed window and were ignored`);
  finish();
}).catch((e) => {
  check('reorder test run aborted', false, e.message);
  finish();
});
