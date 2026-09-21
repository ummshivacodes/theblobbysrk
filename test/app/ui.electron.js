// Black-box UI test. It drives the REAL DOM of the REAL main process on fixture data and checks what a
// user would see and what lands on disk. It is the characterization test that every refactor must keep
// green UNCHANGED: it knows nothing about renderer internals (no globals, no imports from src/), only
// the DOM contract (ids, classes, text) and the data file. If a check has to change for a refactor to
// pass, the refactor changed behaviour: stop and ask.
//
//   npm run test:ui
//
// Needs a GUI session: it briefly shows a Blob window, a tray icon and a Dock icon (~20 s), so don't
// type while it runs. Isolated by construction (see scripts/lib/isolatedApp.js): fixture data and its
// own profile, never your real threads.json, so it is safe to run while Blob itself is running.
const { bootIsolatedApp } = require('../../scripts/lib/isolatedApp.js');
const { waitFor, createReporter } = require('./harness.js');

const T = 1700000000000;
const COLOR = { 1: '#e15656', 2: '#4a86e8', 3: '#e0b23e' };
const NEW = 'a brand new thought';

// One item of every status that can be saved (`resolving` only exists for 700 ms, so it is caught live).
const ctx = bootIsolatedApp({
  fixture: {
    threads: [
      { id: 'inbox1', text: 'untagged inbox item', quad: null, status: 'dump', createdAt: T + 1 },
      { id: 'dump3', text: 'tagged dump item', quad: 3, status: 'dump', createdAt: T + 2 },
      { id: 'axis1', text: 'axis thread one', quad: 1, status: 'axis', createdAt: T + 3 },
      { id: 'axis2', text: 'axis thread two', quad: 2, status: 'axis', createdAt: T + 4 },
      { id: 'done2', text: 'finished thread', quad: 2, status: 'done', createdAt: T + 5, doneAt: T + 6 },
    ],
    stats: { listed: 5, done: 1 },
    history: [{ id: 'done2', text: 'finished thread', quad: 2, createdAt: T + 5, doneAt: T + 6 }],
  },
});
const { app, BrowserWindow } = ctx;
const { check, expectEq, finish } = createReporter({ app, cleanup: ctx.cleanup });

// ---------------------------------------------------------------------------------------------
// Runs IN THE PAGE (its source is injected). DOM only: it must not touch anything the app defines.
// Every action returns a fresh snapshot taken in the same JS turn, so "what does the UI look like
// right after the click" is deterministic and never races the app's own timers.
// ---------------------------------------------------------------------------------------------
function pageDriver() {
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const need = (el, what) => {
    if (!el) throw new Error(`no such element: ${what}`);
    return el;
  };
  // mouseenter/mouseleave don't bubble, as in a real browser.
  const fire = (el, type, init = {}) => el.dispatchEvent(new MouseEvent(type, {
    bubbles: type !== 'mouseenter' && type !== 'mouseleave', cancelable: true, ...init,
  }));
  const cls = (el, drop = []) => [...el.classList].filter((c) => !drop.includes(c)).sort();
  const txt = (id) => document.getElementById(id).textContent;
  const rowEl = (text) => $$('#taskList .task-row').find((r) => $('.task-text', r).textContent === text) || null;
  const barEl = (id) => $(`#axisSvg g.bar-g[data-id="${id}"]`);

  function snapshot() {
    const orb = $('.orb');
    const shown = (id) => $(id).style.display;
    return {
      ready: document.documentElement.dataset.ready === '1',
      panelOpen: $('#panel').classList.contains('open'),
      panelDisplay: $('#panel').style.display,
      screen: $('#mainScreen').classList.contains('active') ? 'main'
        : $('#doneScreen').classList.contains('active') ? 'done' : '?',
      counts: { axis: txt('axisCount'), dump: txt('taskCount'), done: txt('doneCount'), listed: txt('listedCount'), active: txt('activeCount') },
      rows: $$('#taskList .task-row').map((r) => ({
        id: r.dataset.id,
        text: $('.task-text', r).textContent,
        cls: cls(r, ['task-row', 'fresh']),
        chip: $('.tag-chip', r) ? $('.tag-chip', r).textContent : null,
        chipStatic: !!$('.tag-chip.static', r),
        dots: $$('.tag-dot', r).map((d) => d.textContent),
        acts: $$('.task-act', r).map((b) => b.textContent),
      })),
      bars: $$('#axisSvg g.bar-g').map((g) => ({
        id: g.dataset.id,
        cls: cls(g, ['bar-g', 'fresh']),
        color: $('.bar', g).getAttribute('stroke'),
        strike: !!$('.strike', g),
        halo: !!$('.halo', g),
        label: $('.thread-label', g).textContent,
      })),
      cores: $$('.orb .core').map((c) => ({ id: c.dataset.id, cls: cls(c, ['core']), color: c.style.getPropertyValue('--c') })),
      orb: orb ? cls(orb, ['orb']) : null,
      tooltip: { shown: $('#tooltip').classList.contains('show'), text: $('#tooltip').textContent },
      menu: { open: shown('#rowMenu') === 'block', items: $$('#rowMenu button').map((b) => b.textContent) },
      input: { value: $('#taskInput').value, focused: document.activeElement === $('#taskInput') },
      gear: {
        on: $('#gearBtn').classList.contains('on'),
        big: txt('doneBig'),
        listed: txt('doneListed'),
        rows: $$('#doneList .task-row').map((r) => $('.task-text', r).textContent),
      },
    };
  }

  window.__ui = {
    snapshot,
    hoverOrb: (on) => { fire(need($('.orb'), 'the blob'), on ? 'mouseenter' : 'mouseleave'); return snapshot(); },
    hoverShell: (on) => { fire($('#shell'), on ? 'mouseenter' : 'mouseleave'); return snapshot(); },
    click: (sel) => { need($(sel), sel).click(); return snapshot(); },
    rowClick: (text, sel) => {
      need($(sel, need(rowEl(text), `row "${text}"`)), `${sel} in row "${text}"`).click();
      return snapshot();
    },
    dotClick: (text, n) => {
      need($$('.tag-dot', need(rowEl(text), `row "${text}"`))[n - 1], `dot ${n} in row "${text}"`).click();
      return snapshot();
    },
    rowFire: (text, type, init) => { fire(need(rowEl(text), `row "${text}"`), type, init); return snapshot(); },
    barFire: (id, type) => { fire(need(barEl(id), `bar ${id}`), type); return snapshot(); },
    menuClick: (startsWith) => {
      need($$('#rowMenu button').find((b) => b.textContent.startsWith(startsWith)), `menu item "${startsWith}"`).click();
      return snapshot();
    },
    typeEnter: (value) => {
      const input = $('#taskInput');
      input.value = value;
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      return snapshot();
    },
    key: (key) => { document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })); return snapshot(); },
    mousedownElsewhere: () => { fire(document.body, 'mousedown'); return snapshot(); },
  };
}

// ---------------------------------------------------------------------------------------------
// Runs here, in the main process.
// ---------------------------------------------------------------------------------------------
let win;
let last = null; // most recent snapshot seen by until(), for failure messages

const act = (name, ...args) => win.webContents.executeJavaScript(
  `window.__ui[${JSON.stringify(name)}](...${JSON.stringify(args)})`);

// Poll snapshots until `pred` holds. Resolves to that snapshot, or null on timeout.
async function until(pred, ms = 5000) {
  const ok = await waitFor(async () => { last = await act('snapshot'); return pred(last); }, ms);
  return ok ? last : null;
}

const brief = (s) => s && JSON.stringify({
  screen: s.screen,
  panelOpen: s.panelOpen,
  input: s.input,
  counts: s.counts,
  rows: s.rows.map((r) => `${r.text} [${r.cls.join(',')}] ${r.chip || r.dots.join('') || '-'} ${r.acts.join('')}`),
  bars: s.bars.map((b) => b.id + (b.cls.length ? `:${b.cls.join(',')}` : '')),
});
const why = (s) => (s ? '' : `timed out; last seen ${brief(last)}`);

const rowOf = (s, text) => s.rows.find((r) => r.text === text);
const barOf = (s, id) => s.bars.find((b) => b.id === id);
const coreOf = (s, id) => s.cores.find((c) => c.id === id);
const pick = ({ text, cls, chip, chipStatic, dots, acts }) => ({ text, cls, chip, chipStatic, dots, acts });

const disk = () => ctx.readData();
const diskThread = (d, text) => d.threads.find((t) => t.text === text);
const untilDisk = (pred, ms = 4000) => waitFor(() => pred(disk()), ms);

app.whenReady().then(async () => {
  win = BrowserWindow.getAllWindows()[0];
  if (win.webContents.isLoading()) await new Promise((r) => win.webContents.once('did-finish-load', r));
  await win.webContents.executeJavaScript(`(${pageDriver.toString()})()`);

  let s = await until((x) => x.ready && x.rows.length === 5, 12000);
  if (!check('boots and draws the saved state', !!s, why(s))) return finish();

  // ---- ambient state: just the blob -------------------------------------------------------
  check('starts collapsed, showing only the blob', !s.panelOpen && s.orb !== null && !s.orb.includes('ghost'));
  check('the window is exactly blob-sized (clicks elsewhere pass through)',
    await waitFor(() => { const b = win.getBounds(); return b.width < 120 && b.height < 120; }));
  expectEq('one core per open thread, coloured by quad',
    s.cores.map((c) => [c.id, c.color]), [['axis1', COLOR[1]], ['axis2', COLOR[2]]]);

  s = await act('hoverOrb', true);
  check('hovering the blob shows the score and the open threads',
    s.tooltip.shown && s.tooltip.text.startsWith('2 active · 1/5 done')
      && s.tooltip.text.includes('axis thread one') && s.tooltip.text.includes('axis thread two'), s.tooltip.text);
  s = await act('hoverOrb', false);
  check('…and leaving hides it', !s.tooltip.shown);

  // ---- the panel opens ----------------------------------------------------------------------
  await act('hoverShell', true);
  s = await until((x) => x.panelOpen && x.panelDisplay === 'block');
  check('hovering the blob unfolds the panel', !!s, why(s));
  check('…and the window grows to fit it',
    await waitFor(() => { const b = win.getBounds(); return b.width >= 340 && b.height >= 400; }));
  expectEq('the scoreboard matches the data', s.counts, { axis: '(2)', dump: '(5)', done: '1', listed: '5', active: '2' });

  // ---- what each status looks like -----------------------------------------------------------
  expectEq('each row offers the right controls for its status', s.rows.map(pick), [
    { text: 'untagged inbox item', cls: [], chip: null, chipStatic: false, dots: ['Q1', 'Q2', 'Q3', 'Q4'], acts: [] },
    { text: 'tagged dump item', cls: [], chip: 'Q3', chipStatic: false, dots: [], acts: ['→'] },
    { text: 'axis thread one', cls: [], chip: 'Q1', chipStatic: false, dots: [], acts: ['←', '✓'] },
    { text: 'axis thread two', cls: [], chip: 'Q2', chipStatic: false, dots: [], acts: ['←', '✓'] },
    { text: 'finished thread', cls: ['done'], chip: 'Q2', chipStatic: true, dots: [], acts: ['↺'] },
  ]);
  expectEq('the axis draws only open threads, coloured by quad, with clipped labels',
    s.bars.map((b) => [b.id, b.color, b.strike, b.halo, b.label]),
    [['axis1', COLOR[1], false, false, 'axis thread…'], ['axis2', COLOR[2], false, false, 'axis thread…']]);
  check('nothing starts hovered, focused or struck', s.rows.every((r) => r.cls.every((c) => c === 'done'))
    && s.bars.every((b) => b.cls.length === 0) && s.orb.length === 0);

  // ---- capture ------------------------------------------------------------------------------
  s = await act('typeEnter', '   ');
  check('Enter on blank input adds nothing', s.rows.length === 5 && s.counts.dump === '(5)');
  s = await act('typeEnter', NEW);
  check('Enter dumps the text as a new untagged task at the end of the list',
    s.rows.length === 6 && rowOf(s, NEW) === s.rows[5] && rowOf(s, NEW).dots.length === 4 && rowOf(s, NEW).acts.length === 0);
  check('…clears the input and bumps the counts',
    s.input.value === '' && s.counts.dump === '(6)' && s.counts.listed === '6' && s.counts.axis === '(2)');
  check('…and saves it to disk', await untilDisk((d) => {
    const t = diskThread(d, NEW);
    return t && t.status === 'dump' && t.quad === null && d.stats.listed === 6;
  }));

  // ---- tagging is only a label; pushing/recalling is explicit ------------------------------------
  s = await act('dotClick', NEW, 3);
  check('tagging shows the chip and a → button, and does NOT move it',
    rowOf(s, NEW).chip === 'Q3' && rowOf(s, NEW).dots.length === 0 && expectArr(rowOf(s, NEW).acts, ['→'])
      && s.bars.length === 2 && s.counts.axis === '(2)');
  check('…saved as a Q3 dump item, with no UI flags leaking into the file', await untilDisk((d) => {
    const t = diskThread(d, NEW);
    return t && t.quad === 3 && t.status === 'dump' && !JSON.stringify(d).includes('retagging');
  }));
  s = await act('rowClick', NEW, '.tag-chip');
  check('clicking the chip offers the four dots again', rowOf(s, NEW).dots.length === 4 && rowOf(s, NEW).chip === null);
  s = await act('dotClick', NEW, 1);
  check('retagging to Q1 changes the label only', rowOf(s, NEW).chip === 'Q1' && s.bars.length === 2);
  check('…saved', await untilDisk((d) => { const t = diskThread(d, NEW); return t && t.quad === 1 && t.status === 'dump'; }));

  s = await act('rowClick', NEW, '.task-act.push');
  const pushedId = rowOf(s, NEW).id;
  check('→ puts it on the axis: a bar, a core, ← and ✓',
    expectArr(rowOf(s, NEW).acts, ['←', '✓']) && s.bars.length === 3 && s.cores.length === 3
      && barOf(s, pushedId).color === COLOR[1] && s.counts.axis === '(3)' && s.counts.active === '3');
  check('…saved as on the axis', await untilDisk((d) => diskThread(d, NEW).status === 'axis'));

  s = await act('rowClick', NEW, '.task-act.recall');
  check('← sends it back to the dump, keeping its tag',
    expectArr(rowOf(s, NEW).acts, ['→']) && rowOf(s, NEW).chip === 'Q1' && s.bars.length === 2 && s.counts.axis === '(2)');
  check('…saved', await untilDisk((d) => { const t = diskThread(d, NEW); return t.status === 'dump' && t.quad === 1; }));

  // ---- closing a thread ----------------------------------------------------------------------
  await act('rowClick', NEW, '.task-act.push');
  s = await act('rowClick', NEW, '.task-act.done');
  check('✓ shows the strike at once (row struck, bar crossed)',
    rowOf(s, NEW).cls.includes('resolving') && barOf(s, pushedId).strike && barOf(s, pushedId).cls.includes('resolving'));
  s = await until((x) => rowOf(x, NEW).cls.includes('done') && x.bars.length === 2);
  check('…then it is done: struck row with ↺, and its bar leaves the axis', !!s, why(s));
  check('…and the score moves',
    s && s.counts.done === '2' && s.counts.active === '2' && s.counts.listed === '6' && s.counts.axis === '(2)'
      && expectArr(rowOf(s, NEW).acts, ['↺']) && rowOf(s, NEW).chipStatic && s.cores.length === 2);
  check('…saved as done, with a timestamp, in the history and the stats', await untilDisk((d) => {
    const t = diskThread(d, NEW);
    return t.status === 'done' && typeof t.doneAt === 'number' && d.stats.done === 2
      && d.history.length === 2 && d.history.some((h) => h.text === NEW);
  }));

  s = await act('rowClick', NEW, '.task-act.undo');
  check('↺ puts it straight back on the axis',
    expectArr(rowOf(s, NEW).acts, ['←', '✓']) && !rowOf(s, NEW).cls.includes('done') && s.bars.length === 3 && s.counts.done === '1');
  check('…giving the point and the history entry back', await untilDisk((d) => {
    const t = diskThread(d, NEW);
    return t.status === 'axis' && !('doneAt' in t) && d.stats.done === 1 && d.history.length === 1;
  }));

  // ---- focus: one spotlight across the blob, the bar and the row -------------------------------
  s = await act('rowClick', 'axis thread one', '.task-text');
  check('clicking an axis row\'s text focuses it everywhere (row, bar + ring, core, blob)',
    rowOf(s, 'axis thread one').cls.includes('focused') && barOf(s, 'axis1').cls.includes('focused') && barOf(s, 'axis1').halo
      && coreOf(s, 'axis1').cls.includes('focused') && s.orb.includes('focused'));
  check('…and remembers it on disk', await untilDisk((d) => d.threads.filter((t) => t.focused).map((t) => t.id).join() === 'axis1'));
  s = await act('rowClick', 'axis thread two', '.task-text');
  check('focusing another moves it: only one at a time',
    !rowOf(s, 'axis thread one').cls.includes('focused') && rowOf(s, 'axis thread two').cls.includes('focused')
      && !barOf(s, 'axis1').cls.includes('focused') && barOf(s, 'axis2').cls.includes('focused'));
  s = await act('rowClick', 'axis thread two', '.task-text');
  check('clicking the focused one again clears it', s.rows.every((r) => !r.cls.includes('focused'))
    && s.bars.every((b) => !b.cls.includes('focused')) && !s.orb.includes('focused'));
  check('…on disk too', await untilDisk((d) => d.threads.every((t) => !('focused' in t))));
  s = await act('rowClick', 'tagged dump item', '.task-text');
  check('only threads on the axis can be focused', s.rows.every((r) => !r.cls.includes('focused')));

  // ---- hover sync: blob core <-> axis bar <-> list row ---------------------------------------------
  s = await act('rowFire', 'axis thread one', 'mouseenter');
  check('hovering a row lights up its bar and its core',
    rowOf(s, 'axis thread one').cls.includes('hovered') && barOf(s, 'axis1').cls.includes('hovered')
      && coreOf(s, 'axis1').cls.includes('hovered') && !barOf(s, 'axis2').cls.includes('hovered'));
  s = await act('rowFire', 'axis thread one', 'mouseleave');
  check('…and leaving clears it', s.rows.every((r) => !r.cls.includes('hovered')) && s.bars.every((b) => !b.cls.includes('hovered')));
  s = await act('barFire', 'axis2', 'mouseenter');
  check('hovering a bar lights up its row and its core',
    rowOf(s, 'axis thread two').cls.includes('hovered') && coreOf(s, 'axis2').cls.includes('hovered'));
  await act('barFire', 'axis2', 'mouseleave');
  s = await act('rowFire', 'tagged dump item', 'mouseenter');
  check('rows still in the dump have nothing to light up',
    s.rows.every((r) => !r.cls.includes('hovered')) && s.bars.every((b) => !b.cls.includes('hovered')));

  // ---- the ⚙ screen -------------------------------------------------------------------------------
  s = await act('click', '#gearBtn');
  check('⚙ opens the crossed-off screen',
    s.screen === 'done' && s.gear.on && s.gear.big === '1' && s.gear.listed === '6' && expectArr(s.gear.rows, ['finished thread']));
  s = await act('key', 'Escape');
  check('Esc steps back to the main screen without closing the panel', s.screen === 'main' && s.panelOpen && !s.gear.on);
  await act('click', '#gearBtn');
  s = await act('click', '#backBtn');
  check('← back does the same', s.screen === 'main');

  // ---- right-click menu -----------------------------------------------------------------------------
  s = await act('rowFire', 'finished thread', 'contextmenu', { clientX: 60, clientY: 60 });
  check('right-click on a crossed-off row offers Reopen and Delete',
    s.menu.open && expectArr(s.menu.items, ['Reopen', 'Delete "finished thread"']));
  s = await act('menuClick', 'Reopen');
  check('Reopen brings it back to the axis and takes the point back',
    !s.menu.open && expectArr(rowOf(s, 'finished thread').acts, ['←', '✓']) && s.counts.done === '0');
  check('…and removes its history entry', await untilDisk((d) => d.history.length === 0 && d.stats.done === 0));
  await act('rowClick', 'finished thread', '.task-act.done');
  s = await until((x) => rowOf(x, 'finished thread').cls.includes('done'));
  check('closing it again works', !!s && s.counts.done === '1', why(s));
  await act('rowFire', 'finished thread', 'contextmenu', { clientX: 60, clientY: 60 });
  s = await act('menuClick', 'Delete');
  check('Delete removes the row', !rowOf(s, 'finished thread') && s.rows.length === 5 && s.counts.dump === '(5)');
  check('…but the lifetime counters and the crossed-off history keep it', await untilDisk((d) =>
    !diskThread(d, 'finished thread') && d.stats.listed === 6 && d.stats.done === 1
      && d.history.some((h) => h.text === 'finished thread')));
  s = await act('click', '#gearBtn');
  check('…so it is still listed on the ⚙ screen', expectArr(s.gear.rows, ['finished thread']));
  await act('click', '#backBtn');
  await act('rowFire', 'tagged dump item', 'contextmenu', { clientX: 60, clientY: 60 });
  s = await act('menuClick', 'Delete');
  check('deleting a dump item works too', !rowOf(s, 'tagged dump item') && s.rows.length === 4);
  s = await act('rowFire', 'untagged inbox item', 'contextmenu', { clientX: 60, clientY: 60 });
  check('the menu opens…', s.menu.open);
  s = await act('mousedownElsewhere');
  check('…and closes when you click elsewhere', !s.menu.open);

  // ---- closing the panel and the window ---------------------------------------------------------------
  s = await act('key', 'Escape');
  s = await until((x) => !x.panelOpen && x.panelDisplay === 'none');
  check('Esc collapses the panel back to the blob', !!s, why(s));
  check('…and the window shrinks with it',
    await waitFor(() => { const b = win.getBounds(); return b.width < 120 && b.height < 120; }));

  await act('hoverShell', true);
  await until((x) => x.panelOpen);
  await act('click', '#hideBtn');
  check('the – button hides the window', await waitFor(() => !win.isVisible()));
  // Wait until the page has processed the hide (a person takes seconds here; `isVisible()` flips
  // before Electron's `hide` event reaches the page, so showing at once would reorder the two).
  s = await until((x) => !x.panelOpen && x.panelDisplay === 'none');
  check('…and the panel drops back to the blob, ready for next time', !!s, why(s));
  win.show();
  s = await until((x) => x.panelOpen && x.input.focused, 5000);
  check('showing it again (hotkey, tray, Dock) opens the panel with the input ready', !!s, why(s));

  // ---- what ended up on disk ----------------------------------------------------------------------
  const d = disk();
  expectEq('the file holds exactly threads, stats and history', Object.keys(d).sort(), ['history', 'stats', 'threads']);
  check('every saved thread has only known fields (no UI flags)', d.threads.every((t) =>
    Object.keys(t).every((k) => ['id', 'text', 'quad', 'status', 'createdAt', 'doneAt', 'focused'].includes(k))));
  expectEq('the final saved threads are the ones left on screen', d.threads.map((t) => [t.text, t.status]), [
    ['untagged inbox item', 'dump'], ['axis thread one', 'axis'], ['axis thread two', 'axis'], [NEW, 'axis'],
  ]);

  // ---- the × button quits ---------------------------------------------------------------------------
  app.once('will-quit', () => {
    check('the × button quits the app', true);
    finish();
  });
  setTimeout(() => {
    check('the × button quits the app', false, 'will-quit never fired');
    finish();
  }, 8000);
  act('click', '#quitBtn').catch(() => { /* the page goes away as the app quits */ });
}).catch((e) => {
  // An unexpected throw (a missing element, a dead window) is a failure, not a hang.
  check('UI test run aborted', false, e.message);
  finish();
});

// Small equality helper for arrays of primitives, usable inside a boolean expression.
function expectArr(actual, expected) {
  return JSON.stringify(actual) === JSON.stringify(expected);
}
