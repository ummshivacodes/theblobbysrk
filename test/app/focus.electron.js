// Black-box test for three related fixes to the axis/focus experience: pushing a thread onto the axis
// now focuses it, the blob's tooltip puts the focused thread first, and the axis bar's drop-shadow
// filters no longer clip the bar down to a thin line. Its own file (not test/app/ui.electron.js, the
// Phase-0 characterization test, which stays unchanged): these are new, deliberate behaviour changes.
//
//   npm run test:focus
//
// Needs a GUI session: briefly shows a Blob window (~10 s). Isolated by construction
// (scripts/lib/isolatedApp.js): fixture data and its own profile, never your real threads.json.
const { bootIsolatedApp } = require('../../scripts/lib/isolatedApp.js');
const { waitFor, createReporter } = require('./harness.js');

const T = 1700000000000;
const ctx = bootIsolatedApp({
  fixture: {
    threads: [
      { id: 'axis1', text: 'axis thread one', quad: 1, status: 'axis', createdAt: T + 1, focused: true },
      { id: 'axis2', text: 'axis thread two', quad: 2, status: 'axis', createdAt: T + 2 },
      { id: 'dump1', text: 'tagged dump item', quad: 3, status: 'dump', createdAt: T + 3 },
    ],
    stats: { listed: 3, done: 0 },
    history: [],
  },
});
const { app, BrowserWindow } = ctx;
const { check, finish } = createReporter({ app, cleanup: ctx.cleanup });

function pageDriver() {
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const rowEl = (text) => $$('#taskList .task-row').find((r) => $('.task-text', r).textContent === text) || null;
  const fire = (el, type, init = {}) => el.dispatchEvent(new MouseEvent(type, {
    bubbles: type !== 'mouseenter' && type !== 'mouseleave', cancelable: true, ...init,
  }));

  function need(el, what) { if (!el) throw new Error(`no such element: ${what}`); return el; }

  function snapshot() {
    return {
      ready: document.documentElement.dataset.ready === '1',
      panelOpen: $('#panel').classList.contains('open'),
      rows: $$('#taskList .task-row').map((r) => ({
        text: $('.task-text', r).textContent,
        focused: r.classList.contains('focused'),
      })),
      tooltip: $('#tooltip').textContent,
      // The two filters, read structurally: userSpaceOnUse with a real (non-zero, non-percentage) region.
      filters: ['raise', 'groove'].map((id) => {
        const f = $(`#${id}`);
        return f && {
          units: f.getAttribute('filterUnits'),
          x: Number(f.getAttribute('x')), y: Number(f.getAttribute('y')),
          width: Number(f.getAttribute('width')), height: Number(f.getAttribute('height')),
        };
      }),
    };
  }

  window.__focus = {
    snapshot,
    hoverOrb: (on) => { fire(need($('.orb'), 'the blob'), on ? 'mouseenter' : 'mouseleave'); return snapshot(); },
    hoverShell: (on) => { fire($('#shell'), on ? 'mouseenter' : 'mouseleave'); return snapshot(); },
    rowClick: (text, sel) => { need($(sel, need(rowEl(text), text)), sel).click(); return snapshot(); },
  };
}

let win;
const act = (name, ...args) => win.webContents.executeJavaScript(
  `window.__focus[${JSON.stringify(name)}](...${JSON.stringify(args)})`);
async function until(pred, ms = 5000) {
  return waitFor(async () => { const s = await act('snapshot'); return pred(s) ? s : false; }, ms);
}
const disk = () => ctx.readData();
const untilDisk = (pred, ms = 4000) => waitFor(() => pred(disk()), ms);
const rowOf = (s, text) => s.rows.find((r) => r.text === text);

app.whenReady().then(async () => {
  win = BrowserWindow.getAllWindows()[0];
  if (win.webContents.isLoading()) await new Promise((r) => win.webContents.once('did-finish-load', r));
  await win.webContents.executeJavaScript(`(${pageDriver.toString()})()`);

  let s = await until((x) => x.ready);
  if (!check('boots with axis thread one already focused (the fixture)', !!s && rowOf(s, 'axis thread one').focused, JSON.stringify(s))) return finish();

  // ---- pushing a task onto the axis focuses it, and un-focuses whatever was focused before ----------
  await act('hoverShell', true);
  s = await until((x) => x.panelOpen);
  if (!check('(setup) the panel opens', !!s, JSON.stringify(s))) return finish();
  s = await act('rowClick', 'tagged dump item', '.task-act.push'); // already tagged (quad 3) in the fixture
  check('pushing a tagged dump item onto the axis focuses it', rowOf(s, 'tagged dump item').focused, JSON.stringify(s.rows));
  check('…and un-focuses the thread that was focused before', !rowOf(s, 'axis thread one').focused);
  check('…saved: exactly one thread is focused, and it is the one just pushed', await untilDisk((d) => {
    const focused = d.threads.filter((t) => t.focused);
    return focused.length === 1 && focused[0].text === 'tagged dump item';
  }));

  // ---- the tooltip puts the focused thread first, marked -----------------------------------------------
  // (The orb is hovered directly — mouseenter/mouseleave don't bubble, so this is independent of the
  // panel, which the previous step already left open; tooltip.show() sets the text synchronously.)
  s = await act('hoverOrb', true);
  const tip = s.tooltip;
  check('the tooltip leads with the focused thread, marked', tip.startsWith('3 active') && tip.includes('▸ tagged dump item'), tip);
  check('…and still includes the other active threads', tip.includes('axis thread one') && tip.includes('axis thread two'), tip);
  check('…with the marked one first, before the others', tip.indexOf('▸ tagged dump item') < tip.indexOf('axis thread one'), tip);

  // ---- the axis bar's drop-shadow filters have a real region, not a percentage of a zero-size bbox ------
  s = await act('snapshot');
  const [raise, groove] = s.filters;
  check('the raise filter (on the vertical bar) uses an explicit, non-zero region', !!raise
    && raise.units === 'userSpaceOnUse' && raise.width > 0 && raise.height > 0, JSON.stringify(raise));
  check('the groove filter (on the horizontal baseline) uses an explicit, non-zero region', !!groove
    && groove.units === 'userSpaceOnUse' && groove.width > 0 && groove.height > 0, JSON.stringify(groove));

  finish();
}).catch((e) => {
  check('focus test run aborted', false, e.message);
  finish();
});
