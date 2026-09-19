// ---------- Task store: state machine lives in taskStore.js ----------
let lastAddedId = null;
const shell = document.getElementById('shell');
const panel = document.getElementById('panel');   // row that gets the pop-in animation

// Shared between the orb row and the axis renderer.
let hoveredId = null;

// taskStore.js owns { threads, stats, history } and every transition on
// them; this file only renders that state and wires up the DOM. Persistence
// (window.threadAxis, the preload.js IPC bridge) and onChange (render) are
// injected so the store itself never touches Electron or the DOM — see
// taskStore.js. `state` stays a live reference into the store (not a copy),
// so reading state.threads etc. here always sees the current data.
const store = createTaskStore(window.threadAxis, render);
const { state, COLORS, activeThreads } = store;

// ---------- Scoreboard ----------
function renderScore() {
  document.getElementById('doneCount').textContent = state.stats.done;
  document.getElementById('listedCount').textContent = state.stats.listed;
  document.getElementById('activeCount').textContent = activeThreads().length;
  renderDoneScreen();
}

// ---------- Gear screen: everything ever crossed off + settings ----------
function fmtWhen(ts) {
  if (!ts) return '';
  const d = new Date(ts), now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).toLowerCase();
  if (sameDay) return `today · ${time}`;
  const yday = new Date(now); yday.setDate(now.getDate() - 1);
  if (d.toDateString() === yday.toDateString()) return `yesterday · ${time}`;
  return d.toLocaleDateString([], { day: 'numeric', month: 'short' });
}

function renderDoneScreen() {
  document.getElementById('doneBig').textContent = state.stats.done;
  document.getElementById('doneListed').textContent = state.stats.listed;
  const list = document.getElementById('doneList');
  list.innerHTML = '';
  const rows = state.history.slice().sort((a, b) => (b.doneAt || 0) - (a.doneAt || 0));
  document.getElementById('doneListCount').textContent = `(${rows.length})`;
  if (rows.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'done-empty';
    empty.textContent = 'Nothing crossed off yet.';
    list.appendChild(empty);
    return;
  }
  rows.forEach((h) => {
    const row = document.createElement('div');
    row.className = 'task-row history';
    const text = document.createElement('span');
    text.className = 'task-text';
    text.textContent = h.text;
    text.title = h.text;
    row.appendChild(text);
    const when = document.createElement('span');
    when.className = 'history-when';
    when.textContent = fmtWhen(h.doneAt);
    row.appendChild(when);
    const chip = document.createElement('span');
    chip.className = `tag-chip q${h.quad} static`;
    chip.textContent = h.quad ? `Q${h.quad}` : '–';
    chip.style.setProperty('--c', COLORS[h.quad] || '#666');
    row.appendChild(chip);
    list.appendChild(row);
  });
}

let screen = 'main';
function showScreen(name) {
  screen = name;
  document.getElementById('mainScreen').classList.toggle('active', name === 'main');
  document.getElementById('doneScreen').classList.toggle('active', name === 'done');
  document.getElementById('gearBtn').classList.toggle('on', name === 'done');
  hideRowMenu();
  if (name === 'main') setTimeout(() => document.getElementById('taskInput').focus(), 0);
}

// ---------- Hover sync (blob cores <-> axis bars <-> list rows) ----------
function setHovered(id) {
  hoveredId = id;
  document.querySelectorAll('.orb .core[data-id]').forEach((el) => {
    el.classList.toggle('hovered', el.dataset.id === id);
  });
  document.querySelectorAll('#axisSvg .bar-g').forEach((g) => {
    g.classList.toggle('hovered', g.dataset.id === id);
  });
  document.querySelectorAll('.task-row[data-id]').forEach((row) => {
    row.classList.toggle('hovered', row.dataset.id === id);
  });
}

function showTooltip(anchorEl, text) {
  const tip = document.getElementById('tooltip');
  const shell = document.getElementById('shell');
  tip.textContent = text;
  tip.classList.add('show');
  // Center under the anchor, clamped inside the shell.
  const o = anchorEl.getBoundingClientRect();
  const s = shell.getBoundingClientRect();
  const tw = tip.offsetWidth;
  let left = o.left - s.left + o.width / 2 - tw / 2;
  left = Math.max(4, Math.min(left, s.width - tw - 4));
  tip.style.left = `${left}px`;
}

function hideTooltip() {
  document.getElementById('tooltip').classList.remove('show');
}

// ---------- The blob: one orb for all threads ----------
const MAX_CORES = 4;

function renderOrbs() {
  const bar = document.getElementById('orbBar');
  bar.innerHTML = '';
  const active = activeThreads();

  const blob = document.createElement('div');
  blob.className = 'orb';
  if (active.length === 0) blob.classList.add('ghost');
  if (active.some((t) => t.focused)) blob.classList.add('focused');

  active.slice(0, MAX_CORES).forEach((t) => {
    const core = document.createElement('div');
    core.className = 'core';
    core.dataset.id = t.id;
    core.style.setProperty('--c', COLORS[t.quad] || '#999');
    if (t.focused) core.classList.add('focused');
    if (t.status === 'resolving') core.classList.add('resolving');
    if (t.id === hoveredId) core.classList.add('hovered');
    blob.appendChild(core);
  });
  if (active.length > MAX_CORES) {
    const more = document.createElement('div');
    more.className = 'more';
    more.textContent = `+${active.length - MAX_CORES}`;
    blob.appendChild(more);
  }

  const score = `${active.length} active · ${state.stats.done}/${state.stats.listed} done`;
  const tip = active.length === 0
    ? score
    : `${score}  —  ${active.map((t) => t.text).join(' · ')}`;
  blob.addEventListener('mouseenter', () => showTooltip(blob, tip));
  blob.addEventListener('mouseleave', hideTooltip);
  blob.addEventListener('click', (e) => {
    e.stopPropagation();
    openPanel();
    document.getElementById('taskInput').focus();
  });
  bar.appendChild(blob);
}

// ---------- Axis ----------
// Keyed: each thread keeps its <g> across renders so a CSS transform
// transition can slide existing bars over when a new one bundles in.
const NS = 'http://www.w3.org/2000/svg';
const AX = { w: 300, h: 120, baseline: 95, barHeight: 60 };

function svgEl(name, attrs = {}) {
  const el = document.createElementNS(NS, name);
  Object.entries(attrs).forEach(([k, v]) => el.setAttribute(k, v));
  return el;
}

function ensureAxisBase(svg) {
  if (svg.querySelector('#axisBase')) return;
  const defs = svgEl('defs');
  defs.innerHTML = `
    <filter id="raise" x="-50%" y="-20%" width="200%" height="140%">
      <feDropShadow dx="0" dy="1.5" stdDeviation="1.6" flood-color="#000" flood-opacity="0.55"/>
    </filter>
    <filter id="groove" x="-5%" y="-100%" width="110%" height="300%">
      <feDropShadow dx="0" dy="1" stdDeviation="0.8" flood-color="#000" flood-opacity="0.5"/>
    </filter>`;
  svg.appendChild(defs);
  const base = svgEl('g', { id: 'axisBase' });
  base.appendChild(svgEl('line', {
    x1: 10, y1: AX.baseline, x2: AX.w - 10, y2: AX.baseline,
    stroke: 'rgba(255,255,255,0.28)', 'stroke-width': 1.5, filter: 'url(#groove)',
  }));
  svg.appendChild(base);
}

function fillBar(g, t) {
  const { baseline, barHeight } = AX;
  g.innerHTML = '';
  g.setAttribute('class',
    'bar-g' +
    (t.id === hoveredId ? ' hovered' : '') +
    (t.focused ? ' focused' : '') +
    (t.status === 'resolving' ? ' resolving' : ''));

  // Gold ring for the focused thread: a wider gold line drawn under the bar.
  if (t.focused) {
    g.appendChild(svgEl('line', {
      x1: 0, y1: baseline + 2, x2: 0, y2: baseline - barHeight - 2,
      'stroke-width': 10, class: 'halo', 'stroke-linecap': 'round',
    }));
  }

  // The bar itself: round-capped, drop-shadowed so it reads as a pin
  // standing proud of the baseline, plus a thin highlight down one edge.
  g.appendChild(svgEl('line', {
    x1: 0, y1: baseline, x2: 0, y2: baseline - barHeight,
    stroke: COLORS[t.quad] || '#999', 'stroke-width': 4.5,
    'stroke-linecap': 'round', class: 'bar', filter: 'url(#raise)',
  }));
  g.appendChild(svgEl('line', {
    x1: -1.2, y1: baseline - 2, x2: -1.2, y2: baseline - barHeight + 1,
    stroke: 'rgba(255,255,255,0.45)', 'stroke-width': 1, 'stroke-linecap': 'round', class: 'bar-sheen',
  }));

  if (t.status === 'resolving') {
    g.appendChild(svgEl('line', {
      x1: -10, y1: baseline - barHeight / 2 - 10, x2: 10, y2: baseline - barHeight / 2 + 10,
      stroke: '#8fd08f', 'stroke-width': 3, 'stroke-linecap': 'round', class: 'strike',
    }));
  }

  const label = svgEl('text', {
    x: 0, y: baseline - barHeight - 8, 'text-anchor': 'middle', class: 'thread-label',
  });
  label.textContent = t.text.length > 12 ? t.text.slice(0, 11) + '…' : t.text;
  g.appendChild(label);
}

function renderAxis() {
  const svg = document.getElementById('axisSvg');
  ensureAxisBase(svg);
  const threads = activeThreads();
  document.getElementById('axisCount').textContent = `(${threads.length})`;

  const gap = (AX.w - 40) / Math.max(threads.length, 1);
  const keep = new Set(threads.map((t) => t.id));

  // Drop bars whose thread was deleted.
  svg.querySelectorAll('g.bar-g').forEach((g) => {
    if (!keep.has(g.dataset.id)) g.remove();
  });

  threads.forEach((t, i) => {
    const x = 25 + i * gap;
    let g = svg.querySelector(`g.bar-g[data-id="${t.id}"]`);
    const fresh = !g;
    if (fresh) {
      g = svgEl('g');
      g.dataset.id = t.id;
      g.style.cursor = 'pointer';
      g.addEventListener('click', () => { if (t.status === 'axis') store.resolveThread(t.id); });
      g.addEventListener('mouseenter', () => setHovered(t.id));
      g.addEventListener('mouseleave', () => setHovered(null));
      // Start at its slot with no transition, then pop up from the baseline.
      g.style.transition = 'none';
      g.style.transform = `translateX(${x}px)`;
      svg.appendChild(g);
    }
    fillBar(g, t);
    if (fresh) {
      g.classList.add('fresh');
      void g.getBoundingClientRect();
      g.style.transition = '';
    }
    g.style.transform = `translateX(${x}px)`;
  });
}

function tagDots(t) {
  const dots = document.createElement('div');
  dots.className = 'tag-dots';
  [1, 2, 3, 4].forEach((q) => {
    const d = document.createElement('button');
    d.className = 'tag-dot';
    d.textContent = `Q${q}`;
    d.title = `Tag Q${q}`;
    d.style.setProperty('--c', COLORS[q]);
    d.onclick = (e) => { e.stopPropagation(); store.tagTask(t.id, q); };
    dots.appendChild(d);
  });
  return dots;
}

function renderList() {
  const list = document.getElementById('taskList');
  const rows = state.threads.slice().sort((a, b) => a.createdAt - b.createdAt);
  document.getElementById('taskCount').textContent = `(${rows.length})`;
  list.innerHTML = '';

  rows.forEach((t) => {
    const row = document.createElement('div');
    row.className = 'task-row';
    row.dataset.id = t.id;
    if (t.focused) row.classList.add('focused');
    if (t.status === 'resolving') row.classList.add('resolving');
    if (t.status === 'done') row.classList.add('done');
    if (t.id === lastAddedId) row.classList.add('fresh');
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showRowMenu(e.clientX, e.clientY, t);
    });

    const text = document.createElement('span');
    text.className = 'task-text';
    text.textContent = t.text;
    text.title = t.status === 'axis' ? 'Click to focus this thread' : t.text;
    text.onclick = () => { if (t.status === 'axis') store.toggleFocus(t.id); };
    row.appendChild(text);
    if (t.status !== 'dump') {
      row.addEventListener('mouseenter', () => setHovered(t.id));
      row.addEventListener('mouseleave', () => setHovered(null));
    }

    // Tag state: untagged → four dots; tagged → one chip (click to retag).
    if (t.status === 'done') {
      const chip = document.createElement('span');
      chip.className = `tag-chip q${t.quad} static`;
      chip.textContent = `Q${t.quad}`;
      chip.style.setProperty('--c', COLORS[t.quad]);
      row.appendChild(chip);
    } else if (t.quad == null || t.retagging) {
      row.appendChild(tagDots(t));
    } else {
      const chip = document.createElement('button');
      chip.className = `tag-chip q${t.quad}`;
      chip.textContent = `Q${t.quad}`;
      chip.title = 'Retag';
      chip.style.setProperty('--c', COLORS[t.quad]);
      chip.onclick = (e) => { e.stopPropagation(); t.retagging = true; renderList(); };
      row.appendChild(chip);
    }

    // Action: dump + tagged → → pushes onto the axis; on the axis → ←
    // recalls it to the dump, ✓ closes the loop; crossed off → ↺ reopens it.
    if (t.status === 'done') {
      const undo = document.createElement('button');
      undo.className = 'task-act undo';
      undo.textContent = '↺';
      undo.title = 'Reopen (undo cross-off)';
      undo.onclick = (e) => { e.stopPropagation(); store.reopenTask(t.id); };
      row.appendChild(undo);
    } else if (t.status === 'axis') {
      const recall = document.createElement('button');
      recall.className = 'task-act recall';
      recall.textContent = '←';
      recall.title = 'Not working on this yet — send back to the dump';
      recall.onclick = (e) => { e.stopPropagation(); store.recallToDump(t.id); };
      row.appendChild(recall);

      const done = document.createElement('button');
      done.className = 'task-act done';
      done.textContent = '✓';
      done.title = 'Close this thread';
      done.onclick = (e) => { e.stopPropagation(); store.resolveThread(t.id); };
      row.appendChild(done);
    } else if (t.status === 'dump' && t.quad != null) {
      const push = document.createElement('button');
      push.className = 'task-act push';
      push.textContent = '→';
      push.title = 'Put on the axis';
      push.onclick = (e) => { e.stopPropagation(); store.dispatchToAxis(t.id); };
      row.appendChild(push);
    }

    list.appendChild(row);
  });

  if (lastAddedId) {
    list.scrollTop = list.scrollHeight;
    lastAddedId = null;
  }
}

// Right-click on a row → tiny menu with Delete. Never on the axis bar.
const rowMenu = document.getElementById('rowMenu');
function showRowMenu(x, y, t) {
  rowMenu.innerHTML = '';
  if (t.status === 'done') {
    const undo = document.createElement('button');
    undo.className = 'reopen';
    undo.textContent = 'Reopen';
    undo.onclick = () => { hideRowMenu(); store.reopenTask(t.id); };
    rowMenu.appendChild(undo);
  }
  const del = document.createElement('button');
  del.textContent = `Delete "${t.text.length > 24 ? t.text.slice(0, 23) + '…' : t.text}"`;
  del.onclick = () => {
    hideRowMenu();
    if (hoveredId === t.id) hoveredId = null; // renderer-local hover state; the store doesn't know about it
    store.deleteTask(t.id);
  };
  rowMenu.appendChild(del);
  rowMenu.style.display = 'block';
  const s = shell.getBoundingClientRect();
  const mw = rowMenu.offsetWidth, mh = rowMenu.offsetHeight;
  rowMenu.style.left = `${Math.min(x - s.left, s.width - mw - 8)}px`;
  rowMenu.style.top = `${Math.min(y - s.top, s.height - mh - 8)}px`;
}
function hideRowMenu() { rowMenu.style.display = 'none'; }
document.addEventListener('mousedown', (e) => { if (!rowMenu.contains(e.target)) hideRowMenu(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideRowMenu(); });

function render() {
  renderOrbs();
  renderAxis();
  renderList();
  renderScore();
  syncWindowSize();
}

// ---------- Expand / collapse + window sizing ----------
const LEAVE_GRACE_MS = 300;
const COLLAPSE_MS = 240;

let expanded = false;
let animating = false;
let leaveTimer = null;
let collapseTimer = null;

// Ask main to make the window exactly the size of the shell.
function sendShellSize() {
  const r = shell.getBoundingClientRect();
  window.threadAxis.resize(Math.ceil(r.width), Math.ceil(r.height));
}

function syncWindowSize() {
  if (animating) return; // the transition's end handler will sync
  sendShellSize();
}

function openPanel() {
  clearTimeout(leaveTimer);
  clearTimeout(collapseTimer);
  if (expanded) return;
  expanded = true;
  animating = true;

  // Measure the target: lay the panel out at its natural height,
  // grow the window first (so nothing is clipped mid-animation),
  // then animate the height from 0.
  panel.style.transition = 'none';
  panel.style.display = 'block';
  panel.style.height = 'auto';
  const targetH = panel.offsetHeight;
  sendShellSize();
  panel.style.height = '0px';
  void panel.offsetHeight; // reflow
  panel.style.transition = '';
  requestAnimationFrame(() => {
    panel.style.height = `${targetH}px`;
    panel.classList.add('open');
    collapseTimer = setTimeout(() => { animating = false; }, COLLAPSE_MS);
  });
}

function closePanel({ immediate = false } = {}) {
  clearTimeout(leaveTimer);
  clearTimeout(collapseTimer);
  if (!expanded) return;
  expanded = false;
  hideTooltip();
  setHovered(null);
  document.getElementById('taskInput').blur();
  if (screen !== 'main') showScreen('main');

  const finish = () => {
    panel.style.display = 'none';
    panel.style.height = '0px';
    animating = false;
    sendShellSize(); // shrink the window only after the panel is gone
  };

  if (immediate) {
    panel.style.transition = 'none';
    panel.classList.remove('open');
    finish();
    void panel.offsetHeight;
    panel.style.transition = '';
    return;
  }

  animating = true;
  panel.classList.remove('open');
  panel.style.height = '0px';
  collapseTimer = setTimeout(finish, COLLAPSE_MS);
}

function scheduleClose() {
  clearTimeout(leaveTimer);
  leaveTimer = setTimeout(() => closePanel(), LEAVE_GRACE_MS);
}

// Hover anywhere on the shell (orbs or the open panel) keeps it open;
// leaving starts the grace timer so orbs → panel doesn't collapse it.
shell.addEventListener('mouseenter', openPanel);
shell.addEventListener('mouseleave', scheduleClose);

// Hotkey reveal: open with the input ready. Hidden: drop to ambient so
// the next reveal starts from the orb row.
window.threadAxis.onShown(() => {
  openPanel();
  setTimeout(() => document.getElementById('taskInput').focus(), 50);
});
window.threadAxis.onHidden(() => closePanel({ immediate: true }));

// Escape: first step out of the gear screen, then collapse the panel.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (screen !== 'main') showScreen('main');
  else closePanel();
});

// ---------- Wiring (unchanged) ----------
document.getElementById('taskInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.value.trim()) {
    // addTask() already renders once (via the store's onChange) before this
    // line runs, so lastAddedId isn't set yet for that pass — re-render the
    // list right after so the new row still gets its "fresh" highlight and
    // the list still scrolls to it, exactly as before the extraction.
    lastAddedId = store.addTask(e.target.value.trim());
    renderList();
    e.target.value = '';
  }
});

document.getElementById('hideBtn').addEventListener('click', () => window.threadAxis.hide());
document.getElementById('quitBtn').addEventListener('click', () => window.threadAxis.quit());
document.getElementById('gearBtn').addEventListener('click', () => showScreen(screen === 'main' ? 'done' : 'main'));
document.getElementById('backBtn').addEventListener('click', () => showScreen('main'));

// Settings: launch at login (the only real setting so far).
const loginToggle = document.getElementById('loginToggle');
window.threadAxis.getLoginItem().then((on) => { loginToggle.checked = !!on; });
loginToggle.addEventListener('change', async () => {
  loginToggle.checked = !!(await window.threadAxis.setLoginItem(loginToggle.checked));
});

store.loadState();
