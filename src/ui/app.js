// Composition root: the ONE place where things are wired together. It looks up the page's elements
// (so the ids of index.html live here and nowhere else), creates the store and the views, and hands
// each view only the elements and actions it needs. Nothing in here is clever: if a behaviour is, it
// belongs in a module of its own.
import { createItemStore } from '../core/itemStore.js';
import { createBridge } from './bridge.js';
import { createHover } from './hover.js';
import { createPanel } from './panel.js';
import { createRowMenu } from './rowMenu.js';
import { createScreens } from './screens.js';
import { takeSnapshot } from './snapshot.js';
import { createTooltip } from './tooltip.js';
import { createAxisView } from './views/axisView.js';
import { createDoneView } from './views/doneView.js';
import { createInboxView } from './views/inboxView.js';
import { createOrbView } from './views/orbView.js';
import { createScoreView } from './views/scoreView.js';

const $ = (id) => document.getElementById(id);
const pick = (source, names) => Object.fromEntries(names.map((name) => [name, source[name]]));

const bridge = createBridge();
const shell = $('shell');
const input = $('taskInput');

// ---- infrastructure ------------------------------------------------------------------------
const tooltip = createTooltip({ el: $('tooltip'), shell });
const rowMenu = createRowMenu({ el: $('rowMenu'), shell });

const screens = createScreens(
  { main: $('mainScreen'), done: $('doneScreen'), gearBtn: $('gearBtn') },
  {
    onChange(name) {
      rowMenu.hide();
      if (name === 'main') setTimeout(() => input.focus(), 0);
    },
  },
);

const panel = createPanel({
  shell,
  panel: $('panel'),
  windowCtl: bridge.windowCtl,
  onCollapse() {
    tooltip.hide();
    hover.set(null);
    input.blur();
    if (screens.current() !== 'main') screens.show('main');
  },
});

// ---- actions: what the views may ask for. Each view is handed only the ones it uses. ---------
let store; // created below; actions only reach for it when the user acts, after startup

const actions = {
  tag: (id, q) => store.tagTask(id, q),
  push: (id) => store.dispatchToAxis(id),
  recall: (id) => store.recallToDump(id),
  resolve: (id) => store.resolveThread(id),
  reopen: (id) => store.reopenTask(id),
  focus: (id) => store.toggleFocus(id),
  remove: (id) => {
    if (hover.get() === id) hover.set(null); // a deleted row can't stay hovered
    store.deleteTask(id);
  },
  hover: (id) => hover.set(id),
  openMenu: (x, y, entries) => rowMenu.show(x, y, entries),
  showTooltip: (anchor, text) => tooltip.show(anchor, text),
  hideTooltip: () => tooltip.hide(),
  openFromBlob: () => {
    panel.open();
    input.focus();
  },
};

// ---- views ---------------------------------------------------------------------------------
const orb = createOrbView({ bar: $('orbBar') }, pick(actions, ['showTooltip', 'hideTooltip', 'openFromBlob']));
const axis = createAxisView({ svg: $('axisSvg'), count: $('axisCount') }, pick(actions, ['resolve', 'hover']));
const inbox = createInboxView(
  { list: $('taskList'), count: $('taskCount') },
  pick(actions, ['tag', 'push', 'recall', 'resolve', 'reopen', 'focus', 'remove', 'hover', 'openMenu']),
);
const score = createScoreView({ done: $('doneCount'), listed: $('listedCount'), active: $('activeCount') });
const done = createDoneView(
  {
    big: $('doneBig'),
    listed: $('doneListed'),
    list: $('doneList'),
    listCount: $('doneListCount'),
    loginToggle: $('loginToggle'),
  },
  { settings: bridge.settings },
);
const hover = createHover([orb, axis, inbox]);

// ---- render: every change redraws everything from a frozen copy of the state -----------------
function render() {
  const snapshot = takeSnapshot(store.state);
  const ui = { hoveredId: hover.get(), freshId: null };
  orb.render(snapshot, ui);
  axis.render(snapshot, ui);
  inbox.render(snapshot, ui);
  score.render(snapshot);
  done.render(snapshot);
  panel.syncSize();
}

store = createItemStore(bridge.persistence, render);

// ---- wiring --------------------------------------------------------------------------------
input.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || !e.target.value.trim()) return;
  const id = store.addTask(e.target.value.trim());
  // addTask already rendered once (through onChange) before it returned the id, so draw the list once
  // more with the new row highlighted and scrolled into view.
  inbox.render(takeSnapshot(store.state), { hoveredId: hover.get(), freshId: id });
  e.target.value = '';
});

$('hideBtn').addEventListener('click', () => bridge.windowCtl.hide());
$('quitBtn').addEventListener('click', () => bridge.windowCtl.quit());
$('gearBtn').addEventListener('click', () => screens.show(screens.current() === 'main' ? 'done' : 'main'));
$('backBtn').addEventListener('click', () => screens.show('main'));

// Hotkey reveal: open with the input ready. Hidden: drop to ambient, so the next reveal starts from
// the blob.
bridge.lifecycle.onShown(() => {
  panel.open();
  setTimeout(() => input.focus(), 50);
});
bridge.lifecycle.onHidden(() => panel.close({ immediate: true }));

// Escape: first step out of the ⚙ screen, then collapse the panel.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (screens.current() !== 'main') screens.show('main');
  else panel.close();
});

// Readiness flag for tests and tooling: set once the saved state is loaded and drawn, so nothing has
// to poke this app's internals to know the page is up.
store.loadState().then(() => { document.documentElement.dataset.ready = '1'; });
