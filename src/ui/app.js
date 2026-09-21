// Composition root: the ONE place where things are wired together. It looks up the page's elements
// (so the ids of index.html live here and nowhere else), creates the store and the views, and hands
// each view only the elements and actions it needs. Nothing in here is clever: if a behaviour is, it
// belongs in a module of its own.
import { createItemStore } from '../core/itemStore.js';
import { createBridge } from './bridge.js';
import { createHover } from './hover.js';
import { createPanel } from './panel.js';
import { installPressGuard } from './pressGuard.js';
import { createRenderGate } from './renderGate.js';
import { createRowMenu } from './rowMenu.js';
import { createScreens } from './screens.js';
import { takeSnapshot } from './snapshot.js';
import { createTooltip } from './tooltip.js';
import { createAxisView } from './views/axisView.js';
import { createDoneView } from './views/doneView.js';
import { EDIT_ENDED } from './views/bodyEditor.js';
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
  // Mid-sentence: a body is being edited, or the capture box has something in it. (A box that merely has
  // focus, empty, has nothing to lose: it must not keep the panel from folding.)
  isTyping: () => inbox.isEditing() || (document.activeElement === input && input.value.trim() !== ''),
  onCollapse() {
    tooltip.hide();
    hover.set(null);
    // Whatever field has focus (the capture box, a body being edited) lets go. Editors save when they
    // blur, so folding the panel never leaves a half-typed note behind.
    if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
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
  setBody: (id, body) => store.setBody(id, body),
  remove: (id) => {
    if (hover.get() === id) hover.set(null); // a deleted row can't stay hovered
    store.deleteItem(id);
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
  pick(actions, ['tag', 'push', 'recall', 'resolve', 'reopen', 'focus', 'remove', 'setBody', 'hover', 'openMenu']),
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
function drawAll() {
  const snapshot = takeSnapshot(store.state);
  const ui = { hoveredId: hover.get(), freshId: null };
  orb.render(snapshot, ui);
  axis.render(snapshot, ui);
  inbox.render(snapshot, ui);
  score.render(snapshot);
  done.render(snapshot);
  panel.syncSize();
}

// Nothing is redrawn under the user's hands: not while a mouse button is down (a redraw between
// mouse-down and mouse-up swallows the click, and saving an edit on blur happens exactly then), and not
// while they are typing in a body editor (it would destroy the text and the caret). The redraw waits
// and happens once, at the end of the gesture. See ui/renderGate.js.
const POINTER_HOLD_MAX_MS = 5000; // a press that never reports its release must not freeze the page
let pointerDownAt = 0;
const pointerHeld = () => pointerDownAt > 0 && Date.now() - pointerDownAt < POINTER_HOLD_MAX_MS;
const gate = createRenderGate({ draw: drawAll, isHeld: () => pointerHeld() || inbox.isEditing() });

// Any of these can be the end of a gesture: a held redraw may be due, and a postponed fold of the panel
// (the mouse left while the user was typing). Both just ask again whether they are still held; the ones
// that end nothing change nothing. EDIT_ENDED is ours, because focusout is not reliable when an editor
// swaps its own textarea out during blur.
const settleSoon = () => setTimeout(() => { gate.release(); panel.settle(); }, 0); // after the click/blur has run
document.addEventListener('pointerdown', () => { pointerDownAt = Date.now(); }, true);
['pointerup', 'pointercancel'].forEach((type) =>
  document.addEventListener(type, () => { pointerDownAt = 0; settleSoon(); }, true));
['keyup', 'focusout', EDIT_ENDED].forEach((type) => document.addEventListener(type, settleSoon, true));

// Pressing a button while a body is being edited must not pull focus out of it (see ui/pressGuard.js).
installPressGuard({ root: shell, isEditing: () => inbox.isEditing() });

// A save that fails (disk full, permissions) must not be silent. For now it is logged; the Notes work
// shows it to the user in a notice bar, which is where getLoadNotice's recovery message will go too.
store = createItemStore(bridge.persistence, gate.request, {
  onSaveError: (err) => console.error('[blob] could not save:', err),
});

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
