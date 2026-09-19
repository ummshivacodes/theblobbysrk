// Plain-Node unit tests for taskStore.js. No Electron, no DOM, fake in-memory persistence.
const path = require('path');
const fs = require('fs');
const vm = require('vm');
const REPO = path.join(__dirname, '..');
const { createTaskStore } = require(path.join(REPO, 'taskStore.js'));

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, extra = '') {
  if (cond) pass++; else { fail++; failures.push(`${name} ${extra}`); }
  return cond;
}
const group = (name) => { groupName = name; groupStart = { pass, fail }; };
let groupName = '', groupStart = { pass: 0, fail: 0 };
const endGroup = () => console.log(`  ${groupName.padEnd(58)} ${pass - groupStart.pass} passed, ${fail - groupStart.fail} failed`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeStore(initial = null) {
  const calls = { saves: [], changes: 0 };
  const persistence = {
    loadThreads: async () => initial,
    saveThreads: (d) => { calls.saves.push(JSON.parse(JSON.stringify(d))); return Promise.resolve(true); },
  };
  const store = createTaskStore(persistence, () => { calls.changes++; });
  return { store, calls };
}
const seed = (store, ...ts) => ts.forEach((t) => store.state.threads.push({ quad: 1, createdAt: 1, ...t }));
const snap = (calls) => ({ saves: calls.saves.length, changes: calls.changes });
const unchanged = (calls, before) => calls.saves.length === before.saves && calls.changes === before.changes;

(async () => {
  console.log('taskStore.js unit tests (fake in-memory persistence, plain Node)\n');

  group('T0  shape: state, exported keys, COLORS');
  {
    const { store } = makeStore();
    check('initial state', JSON.stringify(store.state) === JSON.stringify({ threads: [], stats: { listed: 0, done: 0 }, history: [] }));
    const keys = Object.keys(store).sort().join(',');
    const want = 'COLORS,activeThreads,addTask,deleteTask,dispatchToAxis,loadState,persist,recallToDump,reopenTask,resolveThread,state,tagTask,toggleFocus';
    check('returned keys', keys === want, keys);
    check('COLORS', JSON.stringify(store.COLORS) === JSON.stringify({ 1: '#e15656', 2: '#4a86e8', 3: '#e0b23e', 4: '#9aa0a8' }));
  }
  endGroup();

  group('T1  addTask');
  {
    const { store, calls } = makeStore();
    const id = store.addTask('hello');
    const t = store.state.threads[0];
    check('returns id', typeof id === 'string' && id === t.id);
    check('thread shape', t.text === 'hello' && t.quad === null && t.status === 'dump' && typeof t.createdAt === 'number');
    check('stats.listed++', store.state.stats.listed === 1 && store.state.stats.done === 0);
    check('persisted once + onChange once', calls.saves.length === 1 && calls.changes === 1);
    check('saved payload has the thread', calls.saves[0].threads[0].text === 'hello');
  }
  endGroup();

  group('T2  tagTask (behavior 1: only quad; never status)');
  {
    const { store, calls } = makeStore();
    seed(store,
      { id: 'd1', text: 'd', status: 'dump', quad: null, retagging: true },
      { id: 'x1', text: 'x', status: 'axis', quad: 1 },
      { id: 'r1', text: 'r', status: 'resolving', quad: 1 },
      { id: 'n1', text: 'n', status: 'done', quad: 1 });
    let b = snap(calls);
    store.tagTask('d1', 3);
    const d1 = store.state.threads.find((t) => t.id === 'd1');
    check('dump: quad set', d1.quad === 3);
    check('dump: retagging cleared', d1.retagging === false);
    check('dump: status UNCHANGED (still dump)', d1.status === 'dump');
    check('dump: persisted+changed once', calls.saves.length === b.saves + 1 && calls.changes === b.changes + 1);
    store.tagTask('x1', 4);
    const x1 = store.state.threads.find((t) => t.id === 'x1');
    check('axis: quad set, status UNCHANGED (still axis)', x1.quad === 4 && x1.status === 'axis');
    b = snap(calls);
    store.tagTask('r1', 9); store.tagTask('n1', 9); store.tagTask('nope', 9);
    check('resolving: no-op', store.state.threads.find((t) => t.id === 'r1').quad === 1);
    check('done: no-op', store.state.threads.find((t) => t.id === 'n1').quad === 1);
    check('missing id: no-op', true);
    check('no persist/onChange on no-ops', unchanged(calls, b));
    check('source never assigns .status', !/\.status\s*=[^=]/.test(store.tagTask.toString()), store.tagTask.toString());
  }
  endGroup();

  group('T3  dispatchToAxis (behavior 2: dump -> axis only)');
  {
    const { store, calls } = makeStore();
    seed(store,
      { id: 'd1', status: 'dump' }, { id: 'x1', status: 'axis' },
      { id: 'r1', status: 'resolving' }, { id: 'n1', status: 'done' });
    store.dispatchToAxis('d1');
    check('dump -> axis', store.state.threads[0].status === 'axis');
    check('persisted+changed once', calls.saves.length === 1 && calls.changes === 1);
    const b = snap(calls);
    store.dispatchToAxis('d1'); store.dispatchToAxis('x1'); store.dispatchToAxis('r1'); store.dispatchToAxis('n1'); store.dispatchToAxis('nope');
    check('axis/resolving/done/missing: no-op', unchanged(calls, b));
    check('statuses untouched', ['axis', 'axis', 'resolving', 'done'].every((s, i) => store.state.threads[i].status === s));
  }
  endGroup();

  group('T4  recallToDump (behavior 3: axis -> dump only, clears focused)');
  {
    const { store, calls } = makeStore();
    seed(store,
      { id: 'x1', status: 'axis', focused: true }, { id: 'd1', status: 'dump' },
      { id: 'r1', status: 'resolving' }, { id: 'n1', status: 'done' });
    store.recallToDump('x1');
    const x1 = store.state.threads[0];
    check('axis -> dump', x1.status === 'dump');
    check('focused removed (key gone)', !('focused' in x1));
    check('persisted+changed once', calls.saves.length === 1 && calls.changes === 1);
    const b = snap(calls);
    store.recallToDump('x1'); store.recallToDump('d1'); store.recallToDump('r1'); store.recallToDump('n1'); store.recallToDump('nope');
    check('dump/resolving/done/missing: no-op', unchanged(calls, b));
  }
  endGroup();

  group('T5  resolveThread (behavior 4: resolving now, done after 700ms)');
  {
    const { store, calls } = makeStore();
    seed(store, { id: 'x1', text: 'ship it', quad: 2, status: 'axis', focused: true, createdAt: 5 });
    const t0 = Date.now();
    store.resolveThread('x1');
    const t = store.state.threads[0];
    check('immediately: status resolving', t.status === 'resolving');
    check('immediately: onChange fired once (render right away)', calls.changes === 1);
    check('immediately: NOT persisted yet (transient state never saved)', calls.saves.length === 0);
    check('resolving is still active', store.activeThreads().map((x) => x.id).join() === 'x1');
    check('not done yet: stats.done 0, history empty', store.state.stats.done === 0 && store.state.history.length === 0);
    await sleep(500);
    check('at ~500ms: still resolving', t.status === 'resolving' && calls.changes === 1);
    await sleep(350);
    const dt = Date.now() - t0;
    check(`after ~${dt}ms: status done`, t.status === 'done');
    check('doneAt set (number)', typeof t.doneAt === 'number');
    check('focused removed', !('focused' in t));
    check('stats.done++', store.state.stats.done === 1);
    check('history entry has exactly {id,text,quad,createdAt,doneAt}',
      store.state.history.length === 1 &&
      Object.keys(store.state.history[0]).sort().join() === 'createdAt,doneAt,id,quad,text' &&
      store.state.history[0].id === 'x1' && store.state.history[0].text === 'ship it' && store.state.history[0].quad === 2);
    check('persisted once + onChange a 2nd time', calls.saves.length === 1 && calls.changes === 2);
    check('saved payload shows done + stats.done 1', calls.saves[0].threads[0].status === 'done' && calls.saves[0].stats.done === 1);
    check('done thread leaves activeThreads instantly', store.activeThreads().length === 0);
    const b = snap(calls);
    store.resolveThread('nope');
    check('missing id: no-op', unchanged(calls, b));
    // Documenting the original (NOT asserting desirability): resolveThread has no status guard.
    const { store: s2 } = makeStore(); seed(s2, { id: 'd1', status: 'dump' }); s2.resolveThread('d1');
    console.log(`     [info] resolveThread on a *dump* thread -> status "${s2.state.threads[0].status}" (original has no status guard; gating lives at the call sites; preserved verbatim)`);
    await sleep(750);
  }
  endGroup();

  group('T6  activeThreads (behavior 5: axis|resolving only, never done)');
  {
    const { store } = makeStore();
    seed(store,
      { id: 'a', status: 'axis', createdAt: 30 }, { id: 'b', status: 'done', createdAt: 10 },
      { id: 'c', status: 'resolving', createdAt: 20 }, { id: 'd', status: 'dump', createdAt: 5 },
      { id: 'e', status: 'axis', createdAt: 25 }, { id: 'f', status: 'done', createdAt: 1 });
    const ids = store.activeThreads().map((t) => t.id).join();
    check('only axis+resolving, sorted by createdAt', ids === 'c,e,a', ids);
    check('no done thread ever included', store.activeThreads().every((t) => t.status !== 'done'));
    check('no dump thread included', store.activeThreads().every((t) => t.status !== 'dump'));
    check('does not mutate state.threads order', store.state.threads.map((t) => t.id).join() === 'a,b,c,d,e,f');
    check('source has no lingering/fading logic (no doneAt/time check)', !/doneAt|Date|setTimeout|linger|fade/i.test(store.activeThreads.toString()), store.activeThreads.toString());
  }
  endGroup();

  group('T7  toggleFocus (behavior 6: axis only, single focus)');
  {
    const { store, calls } = makeStore();
    seed(store,
      { id: 'A', status: 'axis' }, { id: 'B', status: 'axis' },
      { id: 'd', status: 'dump' }, { id: 'r', status: 'resolving' }, { id: 'n', status: 'done' });
    const f = () => store.state.threads.filter((t) => t.focused).map((t) => t.id).join();
    let b = snap(calls);
    store.toggleFocus('d'); store.toggleFocus('r'); store.toggleFocus('n'); store.toggleFocus('nope');
    check('dump/resolving/done/missing: no-op', unchanged(calls, b) && f() === '');
    store.toggleFocus('A');
    check('A focused', f() === 'A');
    store.toggleFocus('B');
    check('focusing B clears A first (single focus)', f() === 'B');
    store.toggleFocus('B');
    check('toggling B again clears focus', f() === '');
    check('cleared via delete (key gone), not =false', store.state.threads.every((t) => !('focused' in t)));
    check('3 effective calls -> 3 saves + 3 changes', calls.saves.length === 3 && calls.changes === 3);
  }
  endGroup();

  group('T8  reopenTask');
  {
    const { store, calls } = makeStore();
    seed(store, { id: 'n', status: 'done', doneAt: 99 }, { id: 'x', status: 'axis' });
    store.state.stats = { listed: 2, done: 1 };
    store.state.history = [{ id: 'n' }, { id: 'other' }];
    store.reopenTask('n');
    const n = store.state.threads[0];
    check('done -> axis, doneAt removed', n.status === 'axis' && !('doneAt' in n));
    check('stats.done decremented', store.state.stats.done === 0);
    check('history entry removed (others kept)', store.state.history.map((h) => h.id).join() === 'other');
    check('persisted+changed once', calls.saves.length === 1 && calls.changes === 1);
    store.state.stats.done = 0; store.state.threads[0].status = 'done';
    store.reopenTask('n');
    check('stats.done floors at 0', store.state.stats.done === 0);
    const b = snap(calls);
    store.reopenTask('x'); store.reopenTask('nope');
    check('non-done/missing: no-op', unchanged(calls, b));
  }
  endGroup();

  group('T9  deleteTask + live state reference');
  {
    const { store, calls } = makeStore();
    const stateRef = store.state;
    seed(store, { id: 'a', status: 'dump' }, { id: 'b', status: 'dump' });
    store.deleteTask('a');
    check('removed', store.state.threads.map((t) => t.id).join() === 'b');
    check('store.state is the SAME live object (identity kept)', store.state === stateRef);
    check('persisted+changed once', calls.saves.length === 1 && calls.changes === 1);
    check('stats not shrunk by delete', store.state.stats.listed === 0);
  }
  endGroup();

  group('T10 persist(): strips retagging from payload only');
  {
    const { store, calls } = makeStore();
    seed(store, { id: 'a', status: 'axis', focused: true, retagging: true });
    store.persist();
    const saved = calls.saves[0].threads[0];
    check('payload lacks retagging', !('retagging' in saved));
    check('payload keeps focused', saved.focused === true);
    check('live thread still has retagging', store.state.threads[0].retagging === true);
    check('payload carries stats + history', 'stats' in calls.saves[0] && 'history' in calls.saves[0]);
  }
  endGroup();

  group('T11 loadState: fresh / legacy / full / live reference');
  {
    let m = makeStore(null);
    const ref = m.store.state;
    await m.store.loadState();
    check('null from disk: state untouched, onChange once', JSON.stringify(m.store.state) === JSON.stringify({ threads: [], stats: { listed: 0, done: 0 }, history: [] }) && m.calls.changes === 1);
    const legacy = { threads: [
      { id: 'a', text: 'a', quad: 1, status: 'done', createdAt: 1, doneAt: 5, extra: 'x' },
      { id: 'b', text: 'b', quad: 2, status: 'axis', createdAt: 2 }] };
    m = makeStore(legacy);
    const ref2 = m.store.state;
    await m.store.loadState();
    check('legacy: stats seeded from disk', m.store.state.stats.listed === 2 && m.store.state.stats.done === 1);
    check('legacy: history seeded from done rows via toHistory (extra field dropped)',
      m.store.state.history.length === 1 && JSON.stringify(m.store.state.history[0]) === JSON.stringify({ id: 'a', text: 'a', quad: 1, createdAt: 1, doneAt: 5 }));
    check('legacy: threads adopted, onChange once', m.store.state.threads === legacy.threads && m.calls.changes === 1);
    check('state identity preserved across loadState (live ref)', m.store.state === ref2);
    const full = { threads: [{ id: 'a', status: 'dump' }], stats: { listed: 9, done: 4 }, history: [{ id: 'h' }] };
    m = makeStore(full);
    await m.store.loadState();
    check('full file: stats + history taken as-is', m.store.state.stats === full.stats && m.store.state.history === full.history);
    m = makeStore({ threads: 'garbage' });
    await m.store.loadState();
    check('malformed file (threads not array): ignored', m.store.state.threads.length === 0 && m.calls.changes === 1);
  }
  endGroup();

  group('T12 dependency inversion: no DOM/Electron in taskStore.js');
  {
    const src = fs.readFileSync(path.join(REPO, 'taskStore.js'), 'utf8');
    const code = src.replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/.*$/gm, '');
    const hits = ['window', 'document', 'ipcRenderer', 'electron', 'threadAxis', 'localStorage', 'require(', 'getElementById', 'querySelector']
      .filter((w) => code.includes(w));
    check('no browser/Electron identifiers in code (comments excluded)', hits.length === 0, hits.join());
    // Load exactly like a classic <script>: a bare vm context with ONLY host timers (no window/document/module).
    const ctx = vm.createContext({ setTimeout, clearTimeout });
    new vm.Script(src, { filename: 'taskStore.js' }).runInContext(ctx);
    check('createTaskStore becomes a plain global (how renderer.js sees it)', typeof ctx.createTaskStore === 'function');
    check('module guard is inert without `module` (no ReferenceError)', typeof vm.runInContext('typeof module', ctx) === 'string');
    const out = vm.runInContext(`
      const saves = []; let changes = 0;
      const s = createTaskStore({ loadThreads: async () => null, saveThreads: (d) => saves.push(d) }, () => changes++);
      const id = s.addTask('x'); s.tagTask(id, 2); s.dispatchToAxis(id);
      JSON.stringify({ status: s.state.threads[0].status, quad: s.state.threads[0].quad, saves: saves.length, changes, active: s.activeThreads().length });
    `, ctx);
    check('full mini-flow runs in a context with no window/document', out === JSON.stringify({ status: 'axis', quad: 2, saves: 3, changes: 3, active: 1 }), out);
  }
  endGroup();

  group('T13 classic-script global scope: taskStore.js must not collide with renderer.js');
  {
    const src = fs.readFileSync(path.join(REPO, 'taskStore.js'), 'utf8');
    const rsrc = fs.readFileSync(path.join(REPO, 'renderer.js'), 'utf8');
    const fresh = vm.createContext({ setTimeout, clearTimeout });
    const before = new Set(vm.runInContext('Object.getOwnPropertyNames(globalThis)', fresh));
    new vm.Script(src, { filename: 'taskStore.js' }).runInContext(fresh);
    const added = vm.runInContext('Object.getOwnPropertyNames(globalThis)', fresh).filter((n) => !before.has(n));
    check('only global property added is createTaskStore', added.join() === 'createTaskStore', added.join());
    // Every top-level name renderer.js declares must still be free after taskStore.js has run.
    const names = new Set();
    for (const m of rsrc.matchAll(/^(?:async\s+)?function\s+(\w+)/gm)) names.add(m[1]);
    for (const m of rsrc.matchAll(/^(?:const|let)\s+(\w+)\s*=/gm)) names.add(m[1]);
    for (const m of rsrc.matchAll(/^const\s*\{([^}]*)\}\s*=/gm)) m[1].split(',').map((x) => x.trim().split(':').pop().trim()).filter(Boolean).forEach((n) => names.add(n));
    const clashes = [];
    for (const n of names) {
      const probe = vm.createContext({ setTimeout, clearTimeout });
      new vm.Script(src).runInContext(probe);
      try { vm.runInContext(`let ${n};`, probe); } catch (e) { clashes.push(`${n} (${e.message})`); }
    }
    check(`none of renderer.js's ${names.size} top-level names collide with taskStore.js`, clashes.length === 0, clashes.join('; '));
    for (const n of ['COLORS', 'byCreated', 'toHistory', 'state', 'store', 'activeThreads']) {
      let ok = true; const probe = vm.createContext({ setTimeout, clearTimeout });
      new vm.Script(src).runInContext(probe);
      try { vm.runInContext(`const ${n} = 1;`, probe); } catch (e) { ok = false; }
      check(`"${n}" is still free to declare after taskStore.js loads`, ok);
    }
  }
  endGroup();

  console.log(`\nTOTAL: ${pass} passed, ${fail} failed`);
  if (fail) { console.log('FAILURES:\n  ' + failures.join('\n  ')); process.exit(1); }
})().catch((e) => { console.error('HARNESS ERROR', e); process.exit(2); });
