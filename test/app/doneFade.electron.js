// Black-box test for a crossed-off task fading out of the main list on its own: DONE_VISIBLE_MS
// (selectors.js) after being crossed off it drops out of #taskList — never deleted, still there
// forever in the ⚙ screen's history (#doneList), where ↺ still revives it, UNLESS the task was also
// deleted from the main list in the meantime, in which case ↺ says so and does nothing rather than
// silently no-op'ing (found by review, fixed in the same pass, not a separate task).
//
//   npm run test:donefade
//
// Real time DOES pass here (waiting on the resolving→done beat, and ticks of app.js's sweep), but not
// the real 30 seconds: rather than shrinking any constant, the page's own Date.now is overridden
// partway through to jump the clock forward, the same way a person leaving it running for 30s would
// experience it — the sweep still has to actually notice on its own next real tick. Total real wait
// here is a handful of seconds, not thirty.
//
// Needs a GUI session: briefly shows a Blob window (~10 s). Isolated by construction
// (scripts/lib/isolatedApp.js): fixture data and its own profile, never your real threads.json.
const { bootIsolatedApp } = require('../../scripts/lib/isolatedApp.js');
const { waitFor, createReporter } = require('./harness.js');

const NOW = Date.now();
const ctx = bootIsolatedApp({
  fixture: {
    threads: [
      // Crossed off moments ago (relative to real wall-clock time, not a fixed historical constant —
      // this must still be "recent" whenever this test actually runs): visible at boot in both lists.
      { id: 'alreadyDone', text: 'already done', quad: 2, status: 'done', createdAt: NOW - 5000, doneAt: NOW - 500 },
      // Also done, and about to be deleted from the main list — reviving THIS one from ⚙ afterwards
      // must be refused, not a silent no-op (the review's finding: history outlives a deleted task).
      { id: 'toDelete', text: 'will be deleted', quad: 4, status: 'done', createdAt: NOW - 4500, doneAt: NOW - 400 },
      // Resolved live during the test, to prove the ordinary resolving→done beat is unaffected.
      { id: 'axis1', text: 'axis thread', quad: 1, status: 'axis', createdAt: NOW - 4000 },
      { id: 'dump1', text: 'still open', quad: 3, status: 'dump', createdAt: NOW - 3000 },
    ],
    stats: { listed: 4, done: 2 },
    history: [
      { id: 'alreadyDone', text: 'already done', quad: 2, createdAt: NOW - 5000, doneAt: NOW - 500 },
      { id: 'toDelete', text: 'will be deleted', quad: 4, createdAt: NOW - 4500, doneAt: NOW - 400 },
    ],
  },
});
const { app, BrowserWindow } = ctx;
const { check, finish } = createReporter({ app, cleanup: ctx.cleanup });

function pageDriver(fixtureNow) {
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const rowEl = (list, text) => $$(`#${list} .task-row`).find((r) => $('.task-text', r).textContent === text) || null;

  function need(el, what) { if (!el) throw new Error(`no such element: ${what}`); return el; }

  function snapshot() {
    const rowsIn = (list) => $$(`#${list} .task-row`).map((r) => {
      const undo = $('.task-act.undo', r);
      return {
        text: $('.task-text', r).textContent,
        acts: $$('.task-act', r).map((b) => b.textContent),
        opacity: Number(getComputedStyle(r).opacity),
        fading: r.classList.contains('fading'),
        undoDisabled: undo ? undo.disabled : null,
        undoTitle: undo ? undo.title : null,
      };
    });
    return {
      ready: document.documentElement.dataset.ready === '1',
      taskList: rowsIn('taskList'),
      doneList: rowsIn('doneList'),
    };
  }

  window.__doneFade = {
    snapshot,
    resolve: (text) => { need($('.task-act.done', need(rowEl('taskList', text), text)), 'resolve').click(); return snapshot(); },
    openGear: () => { need($('#gearBtn'), 'gear').click(); return snapshot(); },
    undo: (list, text) => { need($('.task-act.undo', need(rowEl(list, text), text)), 'undo').click(); return snapshot(); },
    deleteRow: (text) => {
      const row = need(rowEl('taskList', text), text);
      row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 50, clientY: 50 }));
      const del = $$('#rowMenu button').find((b) => b.textContent.startsWith('Delete'));
      need(del, 'delete menu entry').click();
      return snapshot();
    },
    // Relative to the FIXTURE's reference clock (passed in at setup), not to whatever real time it
    // happens to be when this is called — the boot + resolve beat + polling above already eat a real
    // second or two of their own, which a naive "REAL_NOW() + ms" would silently add on top of, making
    // every ms argument below mean something different run to run.
    fastForward: (ms) => { Date.now = () => fixtureNow + ms; return snapshot(); },
  };
}

let win;
const act = (name, ...args) => win.webContents.executeJavaScript(
  `window.__doneFade[${JSON.stringify(name)}](...${JSON.stringify(args)})`);
async function until(pred, ms = 5000) {
  return waitFor(async () => { const s = await act('snapshot'); return pred(s) ? s : false; }, ms);
}
const inList = (s, list, text) => s[list].some((r) => r.text === text);
const rowIn = (s, list, text) => s[list].find((r) => r.text === text);

app.whenReady().then(async () => {
  win = BrowserWindow.getAllWindows()[0];
  if (win.webContents.isLoading()) await new Promise((r) => win.webContents.once('did-finish-load', r));
  await win.webContents.executeJavaScript(`(${pageDriver.toString()})(${NOW})`);

  let s = await until((x) => x.ready);
  if (!check('boots with both already-done items shown in the main list and ⚙', !!s
    && inList(s, 'taskList', 'already done') && inList(s, 'taskList', 'will be deleted')
    && inList(s, 'doneList', 'already done') && inList(s, 'doneList', 'will be deleted'), JSON.stringify(s))) return finish();
  check('…at full dimmed opacity this early on, not already fading', rowIn(s, 'taskList', 'already done').opacity > 0.4
    && !rowIn(s, 'taskList', 'already done').fading);

  // ---- the ordinary resolving→done beat is unaffected ------------------------------------------------
  s = await act('resolve', 'axis thread');
  s = await until((x) => inList(x, 'taskList', 'axis thread') && rowIn(x, 'taskList', 'axis thread').acts.includes('↺'), 2000);
  if (!check('resolving still lands in the main list as done, after its usual beat', !!s, JSON.stringify(s))) return finish();

  // ---- deleting a done task removes it from the main list but never from ⚙ history --------------------
  s = await act('deleteRow', 'will be deleted');
  check('(setup) deleting it removes the row from the main list but not from ⚙ history', !inList(s, 'taskList', 'will be deleted'));

  // ---- a done item that was ALSO deleted from the main list can't be revived, and says so -------------
  s = await act('openGear');
  const orphan = rowIn(s, 'doneList', 'will be deleted');
  check('its ⚙ row is still there', !!orphan, JSON.stringify(s.doneList));
  check('…but ↺ is disabled, not silently doing nothing', orphan?.undoDisabled === true, JSON.stringify(orphan));
  check('…and says why', typeof orphan?.undoTitle === 'string' && orphan.undoTitle.toLowerCase().includes('delete'), orphan?.undoTitle);
  s = await act('undo', 'doneList', 'will be deleted');
  check('…clicking the disabled ↺ really does nothing (no thread reappears anywhere)', !inList(s, 'taskList', 'will be deleted')
    && inList(s, 'doneList', 'will be deleted'), JSON.stringify(s));
  await act('openGear'); // back to the main screen, for the fade checks below to read #taskList again

  // ---- the last few seconds are a real fade, not a flat cut ------------------------------------------
  // 28.5s in: inside the 4s fade window (DONE_FADE_MS in ui/format.js), comfortably before the 30s cutoff.
  await act('fastForward', 28500);
  s = await until((x) => rowIn(x, 'taskList', 'already done')?.fading, 3000);
  if (!check('a done row nearing its cutoff picks up .fading', !!s, JSON.stringify(s))) return finish();
  const midFade = rowIn(s, 'taskList', 'already done').opacity;
  check('…and its opacity is actually partway down, not stuck at full or already zero', midFade > 0 && midFade < 0.45, midFade);
  check('…the still-open task is untouched', rowIn(s, 'taskList', 'still open').opacity === 1
    && !rowIn(s, 'taskList', 'still open').fading, JSON.stringify(s.taskList));

  // ---- past the cutoff, both remaining done items drop out of the main list on their own ----------------
  // A bigger margin than the fade check above needs: 'axis thread' was resolved live a real moment
  // ago (the previous step's actual 700ms beat + polling), so ITS doneAt is a few real seconds after
  // fixtureNow, not exactly fixtureNow like 'already done' — comfortably clearing that drift too.
  await act('fastForward', 40 * 1000);
  s = await until((x) => !inList(x, 'taskList', 'already done') && !inList(x, 'taskList', 'axis thread'), 3000);
  if (!check('past the cutoff, both drop out of the main list on their own, without any click', !!s, JSON.stringify(s))) return finish();
  check('…the still-open task is still untouched', inList(s, 'taskList', 'still open'));

  // ---- but they are still in ⚙, forever, exactly the way a manual cross-off always has been ------------
  s = await act('openGear');
  check('…and both are still right there in ⚙, revivable', inList(s, 'doneList', 'already done') && inList(s, 'doneList', 'axis thread'), JSON.stringify(s.doneList));

  // ---- reviving one from ⚙ actually brings it back to the working list, not just flips a flag -----------
  s = await act('undo', 'doneList', 'already done');
  check('↺ from ⚙ sends it back to the axis, off the done list there too', !inList(s, 'doneList', 'already done'), JSON.stringify(s.doneList));
  await act('openGear'); // back to the main screen (openGear toggles), to see the live task list again
  s = await act('snapshot');
  check('…and it is back in the main list, on the axis, no longer "done"', inList(s, 'taskList', 'already done')
    && !rowIn(s, 'taskList', 'already done').acts.includes('↺'), JSON.stringify(s.taskList));

  finish();
}).catch((e) => {
  check('done-fade test run aborted', false, e.message);
  finish();
});
