// Black-box test of the NOTES UI: the expander and body editor, filing notes, the Notes screen, links.
// Like test/app/ui.electron.js it drives the REAL DOM of the REAL main process on fixture data, knows
// nothing about renderer internals, and never touches your real threads.json (scripts/lib/isolatedApp.js).
// It is separate from that file on purpose: that one is the characterization test of today's behaviour
// and stays unchanged; this one grows with the notes work.
//
//   npm run test:notes
//
// Needs a GUI session: it shows a Blob window for about 30 s, but it does not interfere with whatever you
// are doing, and you cannot interfere with it. The window refuses focus and ignores your real mouse, so
// your typing goes where you are typing and a pointer resting at the top-right of the screen cannot fold
// the panel mid-test; the page is told to behave as if it were focused (Chromium's focus emulation), so
// blur and focus events do not depend on which window is active. The pointer checks use real (trusted)
// input events injected straight into the page, which bypass all of that: the bugs they guard against, a
// click lost to the page shifting under it, cannot be reproduced with synthetic ones.
const { app: electronApp } = require('electron');
const { bootIsolatedApp } = require('../../scripts/lib/isolatedApp.js');
const { sleep, waitFor, createReporter } = require('./harness.js');

// Seal the window off from the person at the machine the moment it exists, before it is ever shown: it
// cannot take keyboard focus and it ignores their real mouse. (Doing this after the page loads is too
// late: a click that lands on the freshly shown window in those first moments closes an editor mid-test.)
// Input injected with sendInputEvent goes straight to the page and is unaffected.
//
// The page also learns "the window was shown / hidden" from two events main sends. This test sends them
// itself and swallows the ones the operating system's own notifications would cause: macOS reports a
// window as hidden when something merely covers it (even while isVisible() is true) and shows it late
// after startup, which folds the panel or steals the caret at random moments and makes every
// timing-sensitive check flaky. (The real show/hide wiring is covered by test/app/lifecycle.electron.js
// and test/app/ui.electron.js; here only the page's reaction to those two events matters.)
let sendToPage;
electronApp.on('browser-window-created', (event, w) => {
  w.setFocusable(false);
  w.setIgnoreMouseEvents(true);
  sendToPage = w.webContents.send.bind(w.webContents);
  w.webContents.send = (channel, ...args) => {
    if (channel === 'window-shown' || channel === 'window-hidden') return;
    sendToPage(channel, ...args);
  };
});
const lifecycle = (channel) => sendToPage(channel);

const T = 1700000000000;

const ctx = bootIsolatedApp({
  fixture: {
    version: 2,
    threads: [
      { id: 'plain', text: 'plain task', quad: null, status: 'dump', createdAt: T + 1 },
      { id: 'noted', text: 'task with notes', quad: 2, status: 'dump', createdAt: T + 2, body: 'first line\nsecond line', updatedAt: T + 2 },
      { id: 'axis1', text: 'axis thread', quad: 1, status: 'axis', createdAt: T + 3 },
      // Rows below the one the real pointer aims at: when an editor above closes and shrinks, the list can
      // only clamp its scroll position if nothing is below the target, which would hide the bug.
      { id: 'later1', text: 'later task A', quad: null, status: 'dump', createdAt: T + 4 },
      { id: 'later2', text: 'later task B', quad: null, status: 'dump', createdAt: T + 5 },
      { id: 'later3', text: 'later task C', quad: null, status: 'dump', createdAt: T + 6 },
    ],
    stats: { listed: 6, done: 0 },
    history: [],
  },
});
const { app, BrowserWindow } = ctx;
const { check, expectEq, finish } = createReporter({ app, cleanup: ctx.cleanup });

// ---------------------------------------------------------------------------------------------
// Runs IN THE PAGE (its source is injected). DOM only: it must not touch anything the app defines.
// ---------------------------------------------------------------------------------------------
function pageDriver() {
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const need = (el, what) => {
    if (!el) throw new Error(`no such element: ${what}`);
    return el;
  };
  const fire = (el, type, init = {}) => el.dispatchEvent(new MouseEvent(type, {
    bubbles: type !== 'mouseenter' && type !== 'mouseleave', cancelable: true, ...init,
  }));
  const rowEl = (text) => $$('#taskList .task-row').find((r) => $('.task-text', r).textContent === text) || null;
  const row = (text) => need(rowEl(text), `row "${text}"`);
  const inRow = (text, sel) => need($(sel, row(text)), `${sel} in row "${text}"`);

  function snapshot() {
    const active = document.activeElement;
    return {
      ready: document.documentElement.dataset.ready === '1',
      hasFocus: document.hasFocus(),
      panelOpen: $('#panel').classList.contains('open'),
      panelDisplay: $('#panel').style.display,
      // The panel grows over ~220 ms. Anything that measures positions (a real pointer) must wait for this.
      panelSettled: $('#panel').offsetHeight >= $('.panel-inner').offsetHeight,
      capture: { value: $('#taskInput').value, placeholder: $('#taskInput').placeholder, tag: $('#taskInput').tagName },
      badge: { text: $('#notesBtn').textContent, count: $('#notesCount').textContent, pulsing: $('#notesBtn').classList.contains('pulse') },
      dump: $('#taskCount').textContent,
      active: active && active !== document.body ? `${active.tagName.toLowerCase()}${active.className ? `.${String(active.className).split(' ')[0]}` : ''}` : null,
      rows: $$('#taskList .task-row').map((r) => {
        const exp = $('.row-expander', r);
        const edit = $('.body-edit', r);
        const read = $('.body-read', r);
        return {
          id: r.dataset.id,
          text: $('.task-text', r).textContent,
          cls: [...r.classList].filter((c) => !['task-row', 'fresh'].includes(c)).sort(),
          expander: exp && { open: exp.classList.contains('open'), hasBody: exp.classList.contains('has-body'), aria: exp.getAttribute('aria-expanded') },
          body: edit ? { mode: 'edit', value: edit.value, focused: document.activeElement === edit }
            : read ? { mode: 'read', value: read.textContent, empty: read.classList.contains('empty') }
              : null,
          acts: $$('.task-act', r).map((b) => b.textContent),
          dots: $$('.tag-dot', r).map((d) => d.textContent),
          noteDot: !!$('.note-dot', r),
          chip: $('.tag-chip', r) ? $('.tag-chip', r).textContent : null,
        };
      }),
    };
  }

  let marked = null; // a node the test wants to recognise again later
  window.__notes = {
    snapshot,
    hoverShell: (on) => { fire($('#shell'), on ? 'mouseenter' : 'mouseleave'); return snapshot(); },
    rowClick: (text, sel) => { inRow(text, sel).click(); return snapshot(); },
    expander: (text) => { inRow(text, '.row-expander').click(); return snapshot(); },
    // Typing: set the value and tell the page, as a keystroke would.
    type: (text, value) => {
      const area = inRow(text, '.body-edit');
      area.value = value;
      area.dispatchEvent(new Event('input', { bubbles: true }));
      return snapshot();
    },
    // A key pressed while the row's editor has focus.
    key: (text, key, init = {}) => {
      inRow(text, '.body-edit').dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }));
      return snapshot();
    },
    // Type into the capture box and press a key in it (Enter by default), as a person would.
    capture: (value, init = {}) => {
      const box = $('#taskInput');
      box.value = value;
      box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...init }));
      return snapshot();
    },
    dotClick: (text, n) => { $$('.tag-dot', row(text))[n - 1].click(); return snapshot(); },
    mark: (text) => { marked = inRow(text, '.body-edit'); return true; },
    isMarked: (text) => { const area = $('.body-edit', row(text)); return !!area && area === marked; },
    blurActive: () => { if (document.activeElement) document.activeElement.blur(); return snapshot(); },
    // Where to aim a real pointer at: the middle of an element in a row.
    center: (text, sel) => {
      const target = inRow(text, sel);
      target.scrollIntoView({ block: 'nearest' }); // a short list scrolls: make sure the pointer lands on it
      const r = target.getBoundingClientRect();
      const x = Math.round(r.left + r.width / 2 - 2); // a touch left of centre: away from any scrollbar
      const y = Math.round(r.top + r.height / 2);
      // Is the element under that point the target (or inside it)? If not, a click there would miss.
      const under = document.elementFromPoint(x, y);
      return { x, y, hits: !!under && target.contains(under), under: under ? `${under.tagName.toLowerCase()}.${under.className}` : null };
    },
    click: (sel) => { need($(sel), sel).click(); return snapshot(); },
  };
}

// ---------------------------------------------------------------------------------------------
// Runs here, in the main process.
// ---------------------------------------------------------------------------------------------
let win;
let last = null;

const act = (name, ...args) => win.webContents.executeJavaScript(
  `window.__notes[${JSON.stringify(name)}](...${JSON.stringify(args)})`);

async function until(pred, ms = 5000) {
  const ok = await waitFor(async () => { last = await act('snapshot'); return pred(last); }, ms);
  return ok ? last : null;
}
const brief = (s) => s && JSON.stringify({
  panelOpen: s.panelOpen, hasFocus: s.hasFocus, active: s.active,
  rows: s.rows.map((r) => `${r.text} [${r.cls.join(',')}] body=${r.body ? `${r.body.mode}:${JSON.stringify(r.body.value)}` : '-'} ${r.acts.join('')}`),
});
const why = (s) => (s ? '' : `timed out; last seen ${brief(last)}`);
const rowOf = (s, text) => s.rows.find((r) => r.text === text);

const disk = () => ctx.readData();
const diskItem = (d, id) => d.threads.find((t) => t.id === id);
const untilDisk = (pred, ms = 4000) => waitFor(() => pred(disk()), ms);

// A real mouse press, in two halves so a test can look at the page while the button is held down.
// Trusted input events go through the same pipeline as a hand on the mouse (pointer events, focus
// changes), which synthetic DOM events skip.
function pressDown({ x, y }) {
  win.webContents.sendInputEvent({ type: 'mouseMove', x, y });
  win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
}
function pressUp({ x, y }) {
  win.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
}

// The page behaves as if it were the focused, active window, whatever the operating system says. Without
// this, blur() on an unfocused page fires nothing, so every focus-dependent check would depend on which
// window happened to be active. (The window is also sealed off from the person at the machine: see the
// browser-window-created handler at the top.)
async function isolateWindow() {
  win.webContents.debugger.attach('1.3');
  await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
}

app.whenReady().then(async () => {
  win = BrowserWindow.getAllWindows()[0];
  if (win.webContents.isLoading()) await new Promise((r) => win.webContents.once('did-finish-load', r));
  await win.webContents.executeJavaScript(`(${pageDriver.toString()})()`);
  await isolateWindow();

  let s = await until((x) => x.ready && x.rows.length === 6, 12000);
  if (!check('boots and draws the saved state', !!s, why(s))) return finish();
  await act('hoverShell', true);
  s = await until((x) => x.panelOpen && x.panelDisplay === 'block');
  if (!check('the panel opens', !!s, why(s))) return finish();
  check('the page counts as focused (the focus checks below need it)', s.hasFocus);

  // ---- 4a: the expander ------------------------------------------------------------------------
  expectEq('every row has an expander; only the row with a body has it lit',
    s.rows.map((r) => [r.text, r.expander && r.expander.hasBody, r.expander && r.expander.open, r.body]),
    [['plain task', false, false, null], ['task with notes', true, false, null], ['axis thread', false, false, null],
      ['later task A', false, false, null], ['later task B', false, false, null], ['later task C', false, false, null]]);
  expectEq('the existing controls are exactly as before (the expander is not an action, a tag or a dot)',
    s.rows.map((r) => [r.dots.join(''), r.chip, r.acts.join('')]),
    [['Q1Q2Q3Q4', null, ''], ['', 'Q2', '→'], ['', 'Q1', '←✓'], ['Q1Q2Q3Q4', null, ''], ['Q1Q2Q3Q4', null, ''], ['Q1Q2Q3Q4', null, '']]);

  s = await act('expander', 'task with notes');
  check('▸ on a row that has notes shows them, ready to read (not an editor)',
    rowOf(s, 'task with notes').body.mode === 'read' && rowOf(s, 'task with notes').body.value === 'first line\nsecond line'
      && rowOf(s, 'task with notes').expander.open && rowOf(s, 'task with notes').expander.aria === 'true'
      && rowOf(s, 'task with notes').cls.includes('expanded'));
  s = await act('expander', 'task with notes');
  check('…and ▸ again hides them', rowOf(s, 'task with notes').body === null && !rowOf(s, 'task with notes').expander.open
    && rowOf(s, 'task with notes').expander.aria === 'false');

  s = await act('expander', 'plain task');
  s = await until((x) => rowOf(x, 'plain task').body && rowOf(x, 'plain task').body.focused);
  check('▸ on a row with no notes opens an empty editor with the caret in it', !!s && rowOf(s, 'plain task').body.mode === 'edit'
    && rowOf(s, 'plain task').body.value === '', why(s));

  // ---- typing saves as you go, and nothing is redrawn under you ----------------------------------
  await act('mark', 'plain task');
  s = await act('type', 'plain task', 'hello world');
  check('nothing is saved on the first keystroke (it waits for you to pause)', diskItem(disk(), 'plain').body === undefined);
  check('…then it saves by itself while you are still in the editor', await untilDisk((d) => diskItem(d, 'plain').body === 'hello world'));
  s = await act('snapshot');
  const caretKept = rowOf(s, 'plain task').body.focused && await act('isMarked', 'plain task');
  check('…with the caret still in the same editor (no redraw came for it)', caretKept, caretKept ? '' : brief(s));
  check('…and the edit time is recorded', typeof diskItem(disk(), 'plain').updatedAt === 'number');

  s = await act('key', 'plain task', 'Enter', { metaKey: true });
  s = await until((x) => rowOf(x, 'plain task').body && rowOf(x, 'plain task').body.mode === 'read');
  check('⌘↵ finishes: the notes read back as text and the expander lights up', !!s
    && rowOf(s, 'plain task').body.value === 'hello world' && rowOf(s, 'plain task').expander.hasBody, why(s));
  check('…the caret is gone from the page', s.active === null || !s.active.startsWith('textarea'));
  check('…and it is still saved', diskItem(disk(), 'plain').body === 'hello world');

  // ---- Esc ends the edit, keeps the text, and does not fold the panel -----------------------------------
  await act('rowClick', 'plain task', '.body-read');
  s = await until((x) => rowOf(x, 'plain task').body && rowOf(x, 'plain task').body.mode === 'edit' && rowOf(x, 'plain task').body.focused);
  check('clicking the notes text edits it, with the text in place', !!s && rowOf(s, 'plain task').body.value === 'hello world', why(s));
  await act('type', 'plain task', 'hello world, again');
  s = await act('key', 'plain task', 'Escape');
  s = await until((x) => rowOf(x, 'plain task').body && rowOf(x, 'plain task').body.mode === 'read');
  check('Esc ends the edit but keeps what was typed', !!s && rowOf(s, 'plain task').body.value === 'hello world, again', why(s));
  check('…saved', await untilDisk((d) => diskItem(d, 'plain').body === 'hello world, again'));
  check('…and it does not also fold the panel or leave the screen', s.panelOpen && s.panelDisplay === 'block');

  // ---- emptying a body removes it ---------------------------------------------------------------------------
  await act('rowClick', 'plain task', '.body-read');
  await until((x) => rowOf(x, 'plain task').body && rowOf(x, 'plain task').body.mode === 'edit');
  await act('type', 'plain task', '');
  await act('blurActive');
  check('clearing the notes removes them from the file (no empty body is kept)',
    await untilDisk((d) => !('body' in diskItem(d, 'plain'))));
  s = await until((x) => rowOf(x, 'plain task').body && rowOf(x, 'plain task').body.mode === 'edit' && !rowOf(x, 'plain task').expander.hasBody);
  check('…the row is back to "nothing here yet": an empty editor and a dim expander', !!s, why(s));
  await act('expander', 'plain task'); // close it again

  // ---- a change from elsewhere waits until you have stopped typing ---------------------------------------------
  await act('expander', 'task with notes');
  await act('rowClick', 'task with notes', '.body-read');
  s = await until((x) => rowOf(x, 'task with notes').body.mode === 'edit' && rowOf(x, 'task with notes').body.focused);
  check('(setup) editing the notes of another row', !!s, why(s));
  await act('mark', 'task with notes');
  await act('type', 'task with notes', 'first line\nsecond line\nthird, still typing');
  await act('rowClick', 'axis thread', '.task-act.recall'); // something else changes the data, without moving focus
  s = await act('snapshot');
  check('a change made elsewhere does not redraw the list while you are typing',
    await act('isMarked', 'task with notes') && rowOf(s, 'task with notes').body.focused
      && rowOf(s, 'task with notes').body.value === 'first line\nsecond line\nthird, still typing');
  check('…the list still shows the old row until you are done (nothing was drawn)', rowOf(s, 'axis thread').acts.join('') === '←✓');
  await act('blurActive');
  s = await until((x) => rowOf(x, 'axis thread').acts.join('') === '→');
  check('…and when you stop, the change appears', !!s, why(s));
  check('…together with what you typed', !!s && rowOf(s, 'task with notes').body.mode === 'read'
    && rowOf(s, 'task with notes').body.value === 'first line\nsecond line\nthird, still typing');
  check('…both saved', await untilDisk((d) => diskItem(d, 'noted').body === 'first line\nsecond line\nthird, still typing'
    && diskItem(d, 'axis1').status === 'dump'));

  // ---- the panel does not fold mid-sentence ------------------------------------------------------------------------------
  await act('expander', 'plain task');
  s = await until((x) => rowOf(x, 'plain task').body && rowOf(x, 'plain task').body.focused);
  await act('type', 'plain task', 'thinking about');
  await act('hoverShell', false);
  // Well past the 300 ms grace, so a fold would have happened by now, yet short of the 800 ms autosave: the
  // draft must still be unsaved when focus leaves, or leaving has nothing to save (and nothing to redraw).
  await sleep(500);
  s = await act('snapshot');
  check('moving the mouse away while typing does not fold the panel', s.panelOpen && s.panelDisplay === 'block',
    s.panelOpen ? '' : brief(s));
  await act('blurActive');
  s = await until((x) => !x.panelOpen && x.panelDisplay === 'none');
  check('…it folds the moment you stop, as the mouse is still away', !!s, why(s));
  check('…and what was typed is saved', await untilDisk((d) => diskItem(d, 'plain').body === 'thinking about'));

  await act('hoverShell', true);
  s = await until((x) => x.panelOpen && x.panelDisplay === 'block');
  check('(setup) hovering opens it again, with the note as it was left',
    !!s && rowOf(s, 'plain task').body && rowOf(s, 'plain task').body.mode === 'read', why(s));
  await act('hoverShell', false);
  s = await until((x) => !x.panelOpen && x.panelDisplay === 'none');
  check('with nothing being typed, moving away folds the panel as always', !!s, why(s));

  // ---- hiding the window (the hotkey) saves what is being typed ----------------------------------------------------------------
  await act('hoverShell', true);
  await until((x) => x.panelOpen && x.panelDisplay === 'block');
  await act('rowClick', 'plain task', '.body-read');
  s = await until((x) => rowOf(x, 'plain task').body.mode === 'edit' && rowOf(x, 'plain task').body.focused);
  check('(setup) editing again, with the caret in the editor and the page focused', !!s && s.hasFocus, why(s));
  await act('type', 'plain task', 'thinking about, then hidden');
  lifecycle('window-hidden'); // what main sends when ⌘⇧Y hides the window
  const flushed = await waitFor(() => diskItem(disk(), 'plain').body === 'thinking about, then hidden', 600);
  check('hiding while typing saves at once, without waiting for the pause', flushed,
    flushed ? '' : `disk has ${JSON.stringify(diskItem(disk(), 'plain').body)}`);
  s = await until((x) => !x.panelOpen && x.panelDisplay === 'none');
  check('…and the panel drops back to the blob', !!s, why(s));
  lifecycle('window-shown');
  // Showing the window opens the panel and, 50 ms later, puts the caret in the capture box. Let that finish
  // before doing anything else, or the late focus would steal the caret from whatever the test is doing.
  s = await until((x) => x.panelOpen && x.panelDisplay === 'block' && x.active === 'textarea');
  check('showing it again finds the note as it was left, with the capture box ready', !!s && rowOf(s, 'plain task').body
    && rowOf(s, 'plain task').body.value === 'thinking about, then hidden', why(s));

  // ---- 4b: filing a note, ⌘↵, and pasting several lines -----------------------------------------------------------------------------
  s = await act('snapshot');
  check('the capture box says what ⌘↵ does', s.capture.placeholder === 'dump a task or a thought…   ⌘↵ = note');
  check('it is a multi-line box (a one-line input would flatten pasted line breaks)', s.capture.tag === 'TEXTAREA');
  check('the header N button starts with no count', s.badge.text === 'N' && s.badge.count === '' && !s.badge.pulsing);
  expectEq('untagged rows offer an N beside Q1–Q4; a tagged row shows its chip instead',
    s.rows.map((r) => [r.text, r.noteDot]),
    [['plain task', true], ['task with notes', false], ['axis thread', false], ['later task A', true], ['later task B', true], ['later task C', true]]);
  s = await act('rowClick', 'task with notes', '.tag-chip');
  check('retagging a task still in the dump offers N too', rowOf(s, 'task with notes').noteDot);
  s = await act('dotClick', 'task with notes', 2); // back to its own tag: changes nothing
  await act('rowClick', 'axis thread', '.task-act.push'); // (an earlier block sent it back to the dump)
  s = await act('rowClick', 'axis thread', '.tag-chip');
  check('…but a thread on the axis never does (it has to be recalled first)', !rowOf(s, 'axis thread').noteDot && rowOf(s, 'axis thread').dots.length === 4);
  await act('dotClick', 'axis thread', 1);
  await act('rowClick', 'axis thread', '.task-act.recall'); // and back to the dump, where the later blocks expect it

  s = await act('rowClick', 'later task A', '.note-dot');
  check('N files the item as a note: its row leaves the task list', !rowOf(s, 'later task A') && s.rows.length === 5 && s.dump === '(5)');
  check('…the header N button counts it and pulses', s.badge.count === '1' && s.badge.pulsing, JSON.stringify(s.badge));
  check('…saved as a note with no tag, no longer counted as a task', await untilDisk((d) => {
    const t = diskItem(d, 'later1');
    return t && t.status === 'note' && t.quad === null && typeof t.updatedAt === 'number' && d.stats.listed === 5;
  }));
  s = await until((x) => !x.badge.pulsing);
  check('…and the pulse fades by itself', !!s, why(s));

  s = await act('capture', 'call the vet about Bruno', { metaKey: true });
  check('⌘↵ in the capture box saves a note: nothing new in the task list, and the box is cleared',
    s.rows.length === 5 && s.capture.value === '' && s.badge.count === '2' && s.badge.pulsing);
  check('…saved as a note, and not counted as a task', await untilDisk((d) => {
    const t = d.threads.find((x) => x.text === 'call the vet about Bruno');
    return t && t.status === 'note' && d.stats.listed === 5;
  }));

  s = await act('capture', 'sprint retro\nwhat went well\nwhat did not');
  check('Enter with several lines dumps a task titled by the first line', !!rowOf(s, 'sprint retro') && s.capture.value === '');
  check('…with the other lines as its notes (the expander lights up)',
    rowOf(s, 'sprint retro').expander.hasBody && await untilDisk((d) => {
      const t = d.threads.find((x) => x.text === 'sprint retro');
      return t && t.status === 'dump' && t.body === 'what went well\nwhat did not' && d.stats.listed === 6;
    }));
  s = await act('capture', 'a passing thought\nwith some detail', { metaKey: true });
  check('⌘↵ with several lines saves a note with a body', s.badge.count === '3' && await untilDisk((d) => {
    const t = d.threads.find((x) => x.text === 'a passing thought');
    return t && t.status === 'note' && t.body === 'with some detail';
  }));

  s = await act('capture', 'half typed', { isComposing: true });
  check('Enter while an input method is composing captures nothing (it confirms the word)',
    s.capture.value === 'half typed' && s.rows.length === 6 && s.badge.count === '3');
  s = await act('capture', 'a line\nbreak', { shiftKey: true });
  check('Shift+Enter is a new line, not a capture', s.capture.value === 'a line\nbreak' && s.rows.length === 6);
  s = await act('capture', '   \n  ', {});
  check('Enter on a blank box captures nothing', s.rows.length === 6 && s.badge.count === '3');
  s = await act('capture', '   ', { metaKey: true });
  check('…and neither does ⌘↵', s.rows.length === 6 && s.badge.count === '3');
  s = await act('capture', '', {}); // leave the box empty

  // ---- a real press on a button while an editor has focus ---------------------------------------------------------------------
  // Typing a note, then clicking ✓ on the row below it, must work with ONE click. If the press pulled focus
  // out of the editor, the editor would shrink under the pointer and the click would land on nothing.
  s = await until((x) => x.panelSettled);
  check('(setup) the panel has finished opening, so positions are final', !!s, why(s));
  await act('rowClick', 'task with notes', '.body-read');
  s = await until((x) => rowOf(x, 'task with notes').body.mode === 'edit' && rowOf(x, 'task with notes').body.focused);
  check('(setup) editing the notes of the row above, caret in the editor', !!s && s.hasFocus, why(s));
  await act('mark', 'task with notes');
  await act('type', 'task with notes', 'first line\nsecond line\nthird, still typing\nand a fourth');
  const pushAt = await act('center', 'axis thread', '.task-act.push');
  check('(setup) the pointer is aimed at the → button', pushAt.hits,
    `it would land on ${pushAt.under} at ${pushAt.x},${pushAt.y}; window ${JSON.stringify(win.getBounds())}`);
  pressDown(pushAt);
  await sleep(150); // a person's press lasts about this long: anything that moves the page under the pointer happens now
  s = await act('snapshot');
  const sameEditor = await act('isMarked', 'task with notes');
  const held = sameEditor && rowOf(s, 'task with notes').body.focused && rowOf(s, 'task with notes').body.value.endsWith('and a fourth');
  check('while the button is held down the editor stays as it was (same editor, caret still in it)',
    held, held ? '' : `sameEditor=${sameEditor} ${brief(s)}`);
  pressUp(pushAt);
  s = await until((x) => rowOf(x, 'axis thread').acts.join('') === '←✓');
  check('one real click then does what the button says (→ puts it on the axis)', !!s, why(s));
  check('…and ends the edit, showing the notes as text', !!s && rowOf(s, 'task with notes').body.mode === 'read'
    && rowOf(s, 'task with notes').body.value.endsWith('and a fourth'), why(s));
  check('…and the edit is saved', await untilDisk((d) => diskItem(d, 'noted').body.endsWith('and a fourth')
    && diskItem(d, 'axis1').status === 'axis'));

  // Moving from one editor straight to another: click the notes of a different row while editing this one.
  await act('rowClick', 'task with notes', '.body-read');
  s = await until((x) => rowOf(x, 'task with notes').body.mode === 'edit' && rowOf(x, 'task with notes').body.focused);
  check('(setup) editing the notes of one row again', !!s, why(s));
  await act('type', 'task with notes', 'first line\nsecond line\nthird, still typing\nand a fourth\nand a fifth');
  const otherAt = await act('center', 'plain task', '.body-read');
  check('(setup) the pointer is aimed at the other row\'s notes text', otherAt.hits,
    `it would land on ${otherAt.under} at ${otherAt.x},${otherAt.y}`);
  pressDown(otherAt);
  await sleep(150);
  pressUp(otherAt);
  s = await until((x) => rowOf(x, 'plain task').body.mode === 'edit' && rowOf(x, 'plain task').body.focused);
  check('clicking another row\'s notes while editing moves the editor there (caret in it)', !!s, why(s));
  check('…and the first one ended and shows its notes as text', !!s && rowOf(s, 'task with notes').body.mode === 'read'
    && rowOf(s, 'task with notes').body.value.endsWith('and a fifth'), why(s));
  check('…and its edit was saved', await untilDisk((d) => diskItem(d, 'noted').body.endsWith('and a fifth')));
  await act('blurActive');
  // The real pointer stays "inside" the panel after a real press, and Blink then fires trusted mouseenter
  // events on layout changes. This block therefore runs last, and ends by taking the pointer away.
  win.webContents.sendInputEvent({ type: 'mouseLeave', x: -40, y: -40 });

  // ---- what ended up on disk ---------------------------------------------------------------------------------------------------------------
  const d = disk();
  expectEq('the file still holds exactly threads, stats, history and its version', Object.keys(d).sort(),
    ['history', 'stats', 'threads', 'version']);
  check('every saved item has only known fields (no UI state such as "expanded" leaks in)', d.threads.every((t) =>
    Object.keys(t).every((k) => ['id', 'text', 'quad', 'status', 'createdAt', 'updatedAt', 'doneAt', 'focused', 'body', 'linkTitle'].includes(k))));

  finish();
}).catch((e) => {
  check('notes UI test run aborted', false, e.message);
  finish();
});
