import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { registerIpc } = require('../../main/ipc.js');
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// A fake ipcMain that records every registration and lets a test invoke/send
// straight into the handler it captured, exactly like a real page's IPC would.
function fakeIpcMain() {
  const handlers = new Map(); // channel -> { kind: 'handle' | 'on', fn }
  const registrations = []; // in registration order, so "nothing twice" can also check order-independent dupes
  const ipcMain = {
    handle(channel, fn) {
      registrations.push({ channel, kind: 'handle' });
      handlers.set(channel, { kind: 'handle', fn });
    },
    on(channel, fn) {
      registrations.push({ channel, kind: 'on' });
      handlers.set(channel, { kind: 'on', fn });
    },
  };
  // ipcMain.handle's real behaviour: a synchronous throw becomes a rejected
  // promise, exactly like an async handler's rejection would (Electron always
  // delivers invoke() results through a promise).
  const invoke = async (channel, ...args) => {
    const h = handlers.get(channel);
    if (!h || h.kind !== 'handle') throw new Error(`no invoke handler for ${channel}`);
    return h.fn({}, ...args);
  };
  const send = (channel, ...args) => {
    const h = handlers.get(channel);
    if (!h || h.kind !== 'on') throw new Error(`no send handler for ${channel}`);
    return h.fn({}, ...args);
  };
  return { ipcMain, handlers, registrations, invoke, send };
}

function fakePersistence({ loadResults = [{ data: { threads: [] }, recoveredFrom: null, quarantined: null }] } = {}) {
  const saves = [];
  let call = 0;
  return {
    saves,
    load: () => loadResults[Math.min(call++, loadResults.length - 1)],
    save: (data) => { saves.push(data); return true; },
  };
}

function fakeLinks() {
  const calls = { openExternal: [], fetchTitle: [] };
  return {
    calls,
    openExternal: (url) => { calls.openExternal.push(url); return url === 'https://good.example' ? true : false; },
    fetchTitle: async (url) => { calls.fetchTitle.push(url); return url === 'https://good.example' ? 'A Title' : null; },
  };
}

function fakeWindows() {
  const calls = { resize: [], hide: [] };
  return { calls, resize: (size) => calls.resize.push(size), hide: (...args) => calls.hide.push(args) };
}

function fakeSettings() {
  const calls = { getLoginItem: 0, setLoginItem: [] };
  return {
    calls,
    getLoginItem: () => { calls.getLoginItem++; return true; },
    setLoginItem: (on) => { calls.setLoginItem.push(on); return !!on; },
  };
}

function fakeApp() {
  const calls = { quit: 0 };
  return { calls, quit: () => { calls.quit++; } };
}

function setup(overrides = {}) {
  const { ipcMain, handlers, registrations, invoke, send } = fakeIpcMain();
  const services = {
    persistence: fakePersistence(),
    links: fakeLinks(),
    windows: fakeWindows(),
    app: fakeApp(),
    settings: fakeSettings(),
    now: () => 1234,
    ...overrides,
  };
  registerIpc({ ipcMain, ...services });
  return { handlers, registrations, invoke, send, ...services };
}

describe('registration', () => {
  test('registers exactly the ten known channels, each exactly once, with the right kind', () => {
    const { registrations } = setup();
    const byChannel = new Map(registrations.map((r) => [r.channel, r]));
    assert.equal(registrations.length, byChannel.size, 'no channel registered twice');
    assert.deepEqual(
      [...byChannel.entries()].sort(([a], [b]) => a.localeCompare(b)),
      [
        ['fetch-title', { channel: 'fetch-title', kind: 'handle' }],
        ['get-load-notice', { channel: 'get-load-notice', kind: 'handle' }],
        ['get-login-item', { channel: 'get-login-item', kind: 'handle' }],
        ['hide-window', { channel: 'hide-window', kind: 'on' }],
        ['load-threads', { channel: 'load-threads', kind: 'handle' }],
        ['open-external', { channel: 'open-external', kind: 'handle' }],
        ['quit-app', { channel: 'quit-app', kind: 'on' }],
        ['resize-window', { channel: 'resize-window', kind: 'on' }],
        ['save-threads', { channel: 'save-threads', kind: 'handle' }],
        ['set-login-item', { channel: 'set-login-item', kind: 'handle' }],
      ],
    );
  });

  test('matches exactly what preload.js calls (read from its source)', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const preload = fs.readFileSync(path.join(__dirname, '../../preload.js'), 'utf-8');
    const used = [...preload.matchAll(/ipcRenderer\.(?:invoke|send)\(\s*'([^']+)'/g)].map((m) => m[1]);
    const registered = setup().registrations.map((r) => r.channel);
    assert.deepEqual([...new Set(used)].sort(), [...new Set(registered)].sort());
  });
});

describe('load-threads', () => {
  test('returns persistence.load().data', async () => {
    const { invoke } = setup({ persistence: fakePersistence({ loadResults: [{ data: { threads: [{ id: 1 }] }, recoveredFrom: null, quarantined: null }] }) });
    assert.deepEqual(await invoke('load-threads'), { threads: [{ id: 1 }] });
  });

  test('a fresh install (no file) returns null, not an error', async () => {
    const { invoke } = setup({ persistence: fakePersistence({ loadResults: [{ data: null, recoveredFrom: null, quarantined: null }] }) });
    assert.equal(await invoke('load-threads'), null);
  });

  test('every call re-reads: a reload after a crash sees the latest save, not a cached first load', async () => {
    const persistence = fakePersistence({
      loadResults: [
        { data: { threads: [], version: 1 }, recoveredFrom: null, quarantined: null },
        { data: { threads: [], version: 2 }, recoveredFrom: null, quarantined: null },
      ],
    });
    const { invoke } = setup({ persistence });
    assert.deepEqual(await invoke('load-threads'), { threads: [], version: 1 });
    assert.deepEqual(await invoke('load-threads'), { threads: [], version: 2 });
  });
});

describe('save-threads', () => {
  test('saves the given data and resolves true', async () => {
    const { invoke, persistence } = setup();
    const data = { threads: [{ id: 'a' }] };
    assert.equal(await invoke('save-threads', data), true);
    assert.deepEqual(persistence.saves, [data]);
  });

  test('a save failure (e.g. unserialisable data) propagates instead of being swallowed', async () => {
    const persistence = fakePersistence();
    persistence.save = () => { throw new TypeError('circular'); };
    const { invoke } = setup({ persistence });
    await assert.rejects(() => invoke('save-threads', {}), TypeError);
  });
});

describe('get-load-notice: derived from the first recovery, not asked fresh', () => {
  test('null when nothing needed recovering', async () => {
    const { invoke } = setup({ persistence: fakePersistence({ loadResults: [{ data: {}, recoveredFrom: null, quarantined: null }] }) });
    await invoke('load-threads');
    assert.equal(await invoke('get-load-notice'), null);
  });

  test('null before any load has happened at all', async () => {
    const { invoke } = setup();
    assert.equal(await invoke('get-load-notice'), null);
  });

  test('set after a load recovers from the backup, with the kind and a timestamp', async () => {
    const persistence = fakePersistence({ loadResults: [{ data: {}, recoveredFrom: 'backup', quarantined: '/x/threads.corrupt-1.json' }] });
    const { invoke } = setup({ persistence, now: () => 999 });
    await invoke('load-threads');
    assert.deepEqual(await invoke('get-load-notice'), { kind: 'recovered-from-backup', at: 999 });
  });

  test('stays set even though a second load-threads is clean (persistence.load() is not repeatable)', async () => {
    const persistence = fakePersistence({
      loadResults: [
        { data: {}, recoveredFrom: 'backup', quarantined: '/x/threads.corrupt-1.json' },
        { data: {}, recoveredFrom: null, quarantined: null }, // what a second real load() call actually returns
      ],
    });
    const { invoke } = setup({ persistence, now: () => 111 });
    await invoke('load-threads');
    await invoke('load-threads'); // e.g. a renderer reload
    assert.deepEqual(await invoke('get-load-notice'), { kind: 'recovered-from-backup', at: 111 });
  });

  test('two separate loads that both recover keep the FIRST one\'s timestamp, not the second\'s', async () => {
    const persistence = fakePersistence({
      loadResults: [
        { data: {}, recoveredFrom: 'backup', quarantined: '/x/1.json' },
        { data: {}, recoveredFrom: 'backup', quarantined: '/x/2.json' },
      ],
    });
    const clock = [111, 222]; // a different moment for each recovery, so a wrongly-updated notice is caught
    const { invoke } = setup({ persistence, now: () => clock.shift() });
    await invoke('load-threads'); // recovers at "111"
    let calls = 0;
    const realLoad = persistence.load;
    persistence.load = (...args) => { calls += 1; return realLoad(...args); };
    await invoke('load-threads'); // recovers again ("222"), but must not overwrite the notice
    assert.equal(calls, 1, 'the second load-threads did call load() again (it must: the data is not cached)');
    assert.deepEqual(await invoke('get-load-notice'), { kind: 'recovered-from-backup', at: 111 });
  });

  test('the timestamp is from the first recovery, not updated by a later one', async () => {
    const persistence = fakePersistence({
      loadResults: [
        { data: {}, recoveredFrom: 'backup', quarantined: '/x/1.json' },
        { data: {}, recoveredFrom: 'backup', quarantined: '/x/2.json' },
      ],
    });
    const { invoke } = setup({ persistence, now: () => 1 });
    await invoke('load-threads');
    persistence.load = () => { throw new Error('now() would prove a second write happened'); };
    assert.deepEqual(await invoke('get-load-notice'), { kind: 'recovered-from-backup', at: 1 });
  });
});

describe('resize-window and hide-window', () => {
  test('resize-window forwards the raw payload to windows.resize', () => {
    const { send, windows } = setup();
    send('resize-window', { width: 100, height: 90 });
    assert.deepEqual(windows.calls.resize, [{ width: 100, height: 90 }]);
  });

  test('hide-window calls windows.hide with no arguments (not the IPC event)', () => {
    const { send, windows } = setup();
    send('hide-window');
    assert.deepEqual(windows.calls.hide, [[]]);
  });
});

describe('quit-app', () => {
  test('calls app.quit', () => {
    const { send, app } = setup();
    send('quit-app');
    assert.equal(app.calls.quit, 1);
  });
});

describe('login item', () => {
  test('get-login-item returns settings.getLoginItem()', async () => {
    const { invoke, settings } = setup();
    assert.equal(await invoke('get-login-item'), true);
    assert.equal(settings.calls.getLoginItem, 1);
  });

  test('set-login-item forwards the value and returns what settings reports', async () => {
    const { invoke, settings } = setup();
    assert.equal(await invoke('set-login-item', true), true);
    assert.deepEqual(settings.calls.setLoginItem, [true]);
  });
});

describe('links', () => {
  test('open-external forwards to links.openExternal and returns its boolean', async () => {
    const { invoke, links } = setup();
    assert.equal(await invoke('open-external', 'https://good.example'), true);
    assert.equal(await invoke('open-external', 'javascript:alert(1)'), false);
    assert.deepEqual(links.calls.openExternal, ['https://good.example', 'javascript:alert(1)']);
  });

  test('fetch-title forwards to links.fetchTitle and returns its result', async () => {
    const { invoke, links } = setup();
    assert.equal(await invoke('fetch-title', 'https://good.example'), 'A Title');
    assert.equal(await invoke('fetch-title', 'https://bad.example'), null);
    assert.deepEqual(links.calls.fetchTitle, ['https://good.example', 'https://bad.example']);
  });

  test('main does its own validation: ipc does not pre-filter before calling links', async () => {
    const { invoke, links } = setup();
    await invoke('open-external', 'not a url');
    assert.deepEqual(links.calls.openExternal, ['not a url'], 'passed through, not short-circuited');
  });
});
