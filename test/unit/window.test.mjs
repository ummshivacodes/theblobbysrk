import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createWindowManager } = require('../../main/window.js');

// A fake Electron world. FakeBrowserWindow behaves like the real one where it matters here: any
// call on it after destroy() throws "Object has been destroyed", so a test fails if the manager
// ever touches a dead window.
function makeWorld({ screenWidth = 1440, ready = true, debug = false, startAt = 1700000000000 } = {}) {
  const world = {
    windows: [],
    order: [],                       // cross-object call order, for "before the page loads"
    clock: startAt,
    ready,
    logs: { log: [], warn: [], error: [] },
  };

  class FakeWebContents extends EventEmitter {
    constructor() {
      super();
      this.sent = [];
      this.openHandler = null;
    }
    send(channel, ...args) { this.sent.push([channel, ...args]); }
    setWindowOpenHandler(handler) {
      world.order.push('setWindowOpenHandler');
      this.openHandler = handler;
    }
  }

  class FakeBrowserWindow extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.webContents = new FakeWebContents();
      this.destroyed = false;
      this.visible = true;             // BrowserWindow shows itself by default
      this.calls = [];
      this.bounds = { x: options.x, y: options.y, width: options.width, height: options.height };
      world.windows.push(this);
    }
    alive() {
      if (this.destroyed) throw new Error('Object has been destroyed');
    }
    isDestroyed() { return this.destroyed; }
    isVisible() { this.alive(); return this.visible; }
    setAlwaysOnTop(...args) { this.alive(); this.calls.push(['setAlwaysOnTop', ...args]); }
    setVisibleOnAllWorkspaces(...args) { this.alive(); this.calls.push(['setVisibleOnAllWorkspaces', ...args]); }
    loadFile(file) { this.alive(); world.order.push('loadFile'); this.calls.push(['loadFile', file]); }
    show() { this.alive(); this.visible = true; this.emit('show'); }
    hide() { this.alive(); this.visible = false; this.emit('hide'); }
    focus() { this.alive(); this.calls.push(['focus']); }
    reload() { this.alive(); this.calls.push(['reload']); }
    getBounds() { this.alive(); return { ...this.bounds }; }
    setBounds(bounds, animate) { this.alive(); this.bounds = { ...bounds }; this.calls.push(['setBounds', { ...bounds }, animate]); }
    // What ⌘W / a red-button click does: a cancellable 'close', then the window goes.
    close() {
      this.alive();
      const event = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
      this.emit('close', event);
      if (!event.defaultPrevented) this.destroy();
    }
    destroy() { this.destroyed = true; this.emit('closed'); }
    count(name) { return this.calls.filter((c) => c[0] === name).length; }
  }

  const log = {
    log: (...args) => world.logs.log.push(args),
    warn: (...args) => world.logs.warn.push(args),
    error: (...args) => world.logs.error.push(args),
  };
  const screen = { getPrimaryDisplay: () => ({ workAreaSize: { width: screenWidth, height: 900 } }) };

  world.manager = createWindowManager({
    BrowserWindow: FakeBrowserWindow,
    screen,
    preloadPath: '/app/preload.js',
    indexPath: '/app/index.html',
    debug,
    isReady: () => world.ready,
    now: () => world.clock,
    log,
  });
  world.last = () => world.windows[world.windows.length - 1];
  world.crash = (w, reason = 'crashed') => w.webContents.emit('render-process-gone', {}, { reason });
  return world;
}

describe('create', () => {
  test('builds the window with the same options as before, and loads index.html', () => {
    const world = makeWorld({ screenWidth: 1440 });
    const w = world.manager.create();
    assert.equal(w, world.last());
    assert.deepEqual(w.options, {
      width: 360,
      height: 560,
      x: 1440 - 360 - 24,
      y: 40,
      frame: false,
      transparent: true,
      alwaysOnTop: true,
      resizable: false,
      hasShadow: false,
      backgroundColor: '#00000000',
      webPreferences: { preload: '/app/preload.js', contextIsolation: true, nodeIntegration: false },
    });
    assert.deepEqual(w.calls, [
      ['setAlwaysOnTop', true, 'floating'],
      ['setVisibleOnAllWorkspaces', true, { visibleOnFullScreen: true, skipTransformProcessType: true }],
      ['loadFile', '/app/index.html'],
    ]);
  });

  test('sits 24 px in from the right edge of whatever screen it is on', () => {
    assert.equal(makeWorld({ screenWidth: 1920 }).manager.create().options.x, 1536);
    assert.equal(makeWorld({ screenWidth: 800 }).manager.create().options.x, 416);
  });

  test('there is only ever one: create returns the live window, and builds again only once it is gone', () => {
    const world = makeWorld();
    const first = world.manager.create();
    assert.equal(world.manager.create(), first);
    assert.equal(world.windows.length, 1);
    first.destroy();
    const second = world.manager.create();
    assert.notEqual(second, first);
    assert.equal(world.windows.length, 2);
  });

  test('liveWindow is null before there is one, the window while it lives, and null again once destroyed', () => {
    const world = makeWorld();
    assert.equal(world.manager.liveWindow(), null);
    const w = world.manager.create();
    assert.equal(world.manager.liveWindow(), w);
    w.destroy();
    assert.equal(world.manager.liveWindow(), null);
  });
});

describe('show, hide and toggle', () => {
  test('show builds the window if there is none, then shows and focuses it', () => {
    const world = makeWorld();
    world.manager.show();
    const w = world.last();
    assert.equal(world.windows.length, 1);
    assert.equal(w.visible, true);
    assert.equal(w.count('focus'), 1);
  });

  test('show on a hidden live window reveals it without building another', () => {
    const world = makeWorld();
    const w = world.manager.create();
    w.hide();
    world.manager.show();
    assert.equal(world.windows.length, 1);
    assert.equal(w.visible, true);
    assert.equal(w.count('focus'), 1);
  });

  test('a destroyed window is rebuilt on show, and the dead one is never called', () => {
    const world = makeWorld();
    const dead = world.manager.create();
    dead.destroy();
    assert.doesNotThrow(() => world.manager.show());
    assert.equal(world.windows.length, 2);
    assert.equal(world.last().visible, true);
    assert.equal(world.manager.liveWindow(), world.last());
  });

  test('a destroyed window is rebuilt on toggle too', () => {
    const world = makeWorld();
    world.manager.create().destroy();
    assert.doesNotThrow(() => world.manager.toggle());
    assert.equal(world.windows.length, 2);
    assert.equal(world.last().visible, true);
  });

  test('hide hides a live window, and does nothing when there is none or it is destroyed', () => {
    const world = makeWorld();
    assert.doesNotThrow(() => world.manager.hide());
    assert.equal(world.windows.length, 0, 'hide never builds a window');

    const w = world.manager.create();
    world.manager.hide();
    assert.equal(w.visible, false);

    w.destroy();
    assert.doesNotThrow(() => world.manager.hide());
  });

  test('toggle hides a visible window and shows a hidden one', () => {
    const world = makeWorld();
    const w = world.manager.create();
    assert.equal(w.visible, true);
    world.manager.toggle();
    assert.equal(w.visible, false);
    world.manager.toggle();
    assert.equal(w.visible, true);
    assert.equal(w.count('focus'), 1, 'only showing focuses');
    assert.equal(world.windows.length, 1);
  });

  test('toggle with no window at all builds one and shows it', () => {
    const world = makeWorld();
    world.manager.toggle();
    assert.equal(world.windows.length, 1);
    assert.equal(world.last().visible, true);
  });

  test('until Electron is ready, show and toggle build nothing (the ready handler makes the window)', () => {
    const world = makeWorld({ ready: false });
    world.manager.show();
    world.manager.toggle();
    assert.equal(world.windows.length, 0);

    world.ready = true;
    world.manager.show();
    assert.equal(world.windows.length, 1);
  });

  test('hide still works whether or not Electron is ready', () => {
    const world = makeWorld();
    const w = world.manager.create();
    world.ready = false;
    world.manager.hide();
    assert.equal(w.visible, false);
  });
});

describe('quitting', () => {
  test('once a real quit has started, show and toggle do nothing: no window is built or revealed', () => {
    const world = makeWorld();
    const w = world.manager.create();
    w.hide();
    world.manager.markQuitting();
    world.manager.show();
    world.manager.toggle();
    assert.equal(w.visible, false);
    assert.equal(world.windows.length, 1);

    w.destroy();
    world.manager.show();
    assert.equal(world.windows.length, 1, 'and none is rebuilt during a quit');
  });

  test('closing is prevented and only hides, until a real quit starts', () => {
    const world = makeWorld();
    const w = world.manager.create();
    w.close();                                   // ⌘W
    assert.equal(w.destroyed, false);
    assert.equal(w.visible, false);
    assert.equal(world.manager.liveWindow(), w);

    world.manager.show();
    w.close();
    w.close();
    assert.equal(w.destroyed, false, 'as often as it is asked');
  });

  test('after a real quit starts, closing goes through', () => {
    const world = makeWorld();
    const w = world.manager.create();
    world.manager.markQuitting();
    w.close();
    assert.equal(w.destroyed, true);
  });

  test('a crash during a quit is not reloaded', () => {
    const world = makeWorld();
    const w = world.manager.create();
    world.manager.markQuitting();
    world.crash(w);
    assert.equal(w.count('reload'), 0);
    assert.deepEqual(world.logs.warn, []);
  });
});

describe('what the page is told', () => {
  test('window-shown when the window is shown, window-hidden when it is hidden', () => {
    const world = makeWorld();
    const w = world.manager.create();
    w.hide();
    w.show();
    w.hide();
    assert.deepEqual(w.webContents.sent, [['window-hidden'], ['window-shown'], ['window-hidden']]);
  });

  test('a window closed with ⌘W tells the page it was hidden', () => {
    const world = makeWorld();
    const w = world.manager.create();
    w.close();
    assert.deepEqual(w.webContents.sent, [['window-hidden']]);
  });

  test('each window talks to its own page', () => {
    const world = makeWorld();
    const first = world.manager.create();
    first.destroy();
    const second = world.manager.create();
    second.hide();
    assert.deepEqual(first.webContents.sent, []);
    assert.deepEqual(second.webContents.sent, [['window-hidden']]);
  });
});

describe('a renderer that dies', () => {
  test('is reloaded, and the reason is logged', () => {
    const world = makeWorld();
    const w = world.manager.create();
    for (const reason of ['crashed', 'killed', 'oom', 'launch-failed', 'abnormal-exit']) {
      world.clock += 120 * 1000;                 // far enough apart that the cap never applies
      world.crash(w, reason);
    }
    assert.equal(w.count('reload'), 5);
    assert.deepEqual(world.logs.warn.map((args) => args[1]), ['crashed', 'killed', 'oom', 'launch-failed', 'abnormal-exit']);
    assert.deepEqual(world.logs.warn[0], ['[main] renderer gone:', 'crashed']);
  });

  test('a clean exit is not a crash', () => {
    const world = makeWorld();
    const w = world.manager.create();
    world.crash(w, 'clean-exit');
    assert.equal(w.count('reload'), 0);
    assert.deepEqual(world.logs.warn, []);
  });

  test('three reloads a minute, then it gives up and says so', () => {
    const world = makeWorld();
    const w = world.manager.create();
    for (let i = 0; i < 3; i += 1) {
      world.crash(w);
      world.clock += 1000;
    }
    assert.equal(w.count('reload'), 3);
    assert.deepEqual(world.logs.error, []);

    world.crash(w);                              // the 4th within the minute
    assert.equal(w.count('reload'), 3, 'not reloaded');
    assert.deepEqual(world.logs.error, [['[main] renderer keeps dying; not reloading again']]);

    world.clock += 1000;
    world.crash(w);                              // and it stays given up while the crashes keep coming
    assert.equal(w.count('reload'), 3);
  });

  test('a crash after that minute has passed is reloaded again', () => {
    const world = makeWorld();
    const w = world.manager.create();
    for (let i = 0; i < 4; i += 1) {
      world.crash(w);
      world.clock += 1000;
    }
    assert.equal(w.count('reload'), 3);

    world.clock += 200 * 1000;
    world.crash(w);
    assert.equal(w.count('reload'), 4);
  });

  test('crashes are counted over a rolling 60 seconds, not in fixed minutes', () => {
    const world = makeWorld();
    const w = world.manager.create();
    world.crash(w);                              // t = 0
    world.clock += 59 * 1000;
    world.crash(w);                              // t = 59 s
    world.crash(w);                              // t = 59 s
    assert.equal(w.count('reload'), 3);
    world.crash(w);                              // t = 59 s: four within a minute
    assert.equal(w.count('reload'), 3);
  });

  test('a crash reported after its window was destroyed is ignored, not thrown on', () => {
    const world = makeWorld();
    const w = world.manager.create();
    w.destroy();
    assert.doesNotThrow(() => world.crash(w));
    assert.equal(w.count('reload'), 0);
  });

  test('a rebuilt window is reloaded on a crash too', () => {
    const world = makeWorld();
    world.manager.create().destroy();
    const second = world.manager.create();
    world.crash(second);
    assert.equal(second.count('reload'), 1);
  });
});

describe('resize', () => {
  test('sets the window to the asked size and keeps its top-right corner where it was', () => {
    const world = makeWorld({ screenWidth: 1440 });
    const w = world.manager.create();          // x = 1056, y = 40, 360 wide: right edge at 1416
    world.manager.resize({ width: 100, height: 90 });
    assert.deepEqual(w.calls.filter((c) => c[0] === 'setBounds'), [
      ['setBounds', { x: 1316, y: 40, width: 100, height: 90 }, false],
    ]);
    assert.equal(w.bounds.x + w.bounds.width, 1416);
  });

  test('growing again puts the left edge back, still on the same right edge', () => {
    const world = makeWorld({ screenWidth: 1440 });
    const w = world.manager.create();
    world.manager.resize({ width: 100, height: 90 });
    world.manager.resize({ width: 360, height: 500 });
    assert.deepEqual(w.bounds, { x: 1056, y: 40, width: 360, height: 500 });
  });

  test('never grows past 360 x 560, and never below 1 x 1', () => {
    const world = makeWorld();
    const w = world.manager.create();
    world.manager.resize({ width: 5000, height: 5000 });
    assert.deepEqual([w.bounds.width, w.bounds.height], [360, 560]);
    world.manager.resize({ width: 0, height: -20 });
    assert.deepEqual([w.bounds.width, w.bounds.height], [1, 1]);
    world.manager.resize({ width: Infinity, height: -Infinity });
    assert.deepEqual([w.bounds.width, w.bounds.height], [360, 1]);
  });

  test('sizes are rounded to whole pixels', () => {
    const world = makeWorld();
    const w = world.manager.create();
    world.manager.resize({ width: 100.4, height: 200.5 });
    assert.deepEqual([w.bounds.width, w.bounds.height], [100, 201]);
  });

  test('a window the user dragged keeps its new right edge and top', () => {
    const world = makeWorld();
    const w = world.manager.create();
    w.bounds = { x: 300, y: 120, width: 360, height: 560 };   // dragged: right edge now at 660
    world.manager.resize({ width: 200, height: 150 });
    assert.deepEqual(w.bounds, { x: 460, y: 120, width: 200, height: 150 });
  });

  test('with no live window it does nothing, and builds nothing', () => {
    const world = makeWorld();
    assert.doesNotThrow(() => world.manager.resize({ width: 100, height: 100 }));
    assert.equal(world.windows.length, 0);

    const w = world.manager.create();
    w.destroy();
    assert.doesNotThrow(() => world.manager.resize({ width: 100, height: 100 }));
    assert.equal(w.count('setBounds'), 0);
  });

  test('a malformed request is ignored instead of throwing in the main process', () => {
    const world = makeWorld();
    const w = world.manager.create();
    for (const bad of [undefined, null, {}, { width: 100 }, { height: 100 }, { width: 'wide', height: 'tall' }, { width: NaN, height: NaN }, 5, 'x']) {
      assert.doesNotThrow(() => world.manager.resize(bad), JSON.stringify(bad));
    }
    assert.equal(w.count('setBounds'), 0);
  });

  test('is logged only when debugging', () => {
    const quiet = makeWorld();
    quiet.manager.create();
    quiet.manager.resize({ width: 100, height: 100 });
    assert.deepEqual(quiet.logs.log, []);

    const loud = makeWorld({ debug: true });
    const w = loud.manager.create();
    loud.manager.resize({ width: 100, height: 90 });
    assert.deepEqual(loud.logs.log, [['[resize] asked', { width: 100, height: 90 }, '→ bounds', { ...w.bounds }]]);
  });
});

describe('navigation lockdown', () => {
  test('the page can open no window: every request is denied', () => {
    const world = makeWorld();
    const w = world.manager.create();
    assert.equal(typeof w.webContents.openHandler, 'function');
    for (const details of [
      { url: 'https://example.com', frameName: '', features: '', disposition: 'foreground-tab' },
      { url: 'javascript:alert(1)', disposition: 'new-window' },
      { url: 'file:///etc/passwd', disposition: 'background-tab' },
      {}, undefined,
    ]) {
      assert.deepEqual(w.webContents.openHandler(details), { action: 'deny' }, JSON.stringify(details));
    }
  });

  test('the page can not navigate away: will-navigate is prevented', () => {
    const world = makeWorld();
    const w = world.manager.create();
    assert.equal(w.webContents.listenerCount('will-navigate'), 1);
    const event = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
    w.webContents.emit('will-navigate', event, 'https://example.com/', false, true);
    assert.equal(event.defaultPrevented, true);
  });

  test('it is in place before the page starts loading', () => {
    const world = makeWorld();
    world.manager.create();
    assert.deepEqual(world.order, ['setWindowOpenHandler', 'loadFile']);
  });

  test('a rebuilt window is locked down too', () => {
    const world = makeWorld();
    world.manager.create().destroy();
    const second = world.manager.create();
    assert.deepEqual(second.webContents.openHandler({ url: 'https://example.com' }), { action: 'deny' });
    assert.equal(second.webContents.listenerCount('will-navigate'), 1);
  });

  test('our own reload is not a navigation the page started, so a crash still recovers', () => {
    const world = makeWorld();
    const w = world.manager.create();
    world.crash(w);
    assert.equal(w.count('reload'), 1);
  });
});

describe('debug logging', () => {
  test('off by default: only the crash handler listens to the page', () => {
    const world = makeWorld();
    const w = world.manager.create();
    assert.equal(w.webContents.listenerCount('console-message'), 0);
    assert.equal(w.webContents.listenerCount('did-finish-load'), 0);
    assert.equal(w.webContents.listenerCount('preload-error'), 0);
    assert.equal(w.webContents.listenerCount('render-process-gone'), 1);
  });

  test('THREAD_AXIS_DEBUG=1 logs the page\'s console, load, preload errors and crashes', () => {
    const world = makeWorld({ debug: true });
    const w = world.manager.create();
    w.webContents.emit('console-message', { level: 2, message: 'hello', sourceId: 'renderer.js', lineNumber: 7 });
    w.webContents.emit('did-finish-load');
    w.webContents.emit('preload-error', {}, '/app/preload.js', new Error('bad'));
    world.crash(w, 'oom');

    assert.deepEqual(world.logs.log[0], ['[renderer:2] hello (renderer.js:7)']);
    assert.deepEqual(world.logs.log[1], ['[main] did-finish-load', { ...w.bounds }]);
    assert.equal(world.logs.log[2][0], '[preload-error]');
    assert.equal(world.logs.log[2][1], '/app/preload.js');
    assert.deepEqual(world.logs.log[3], ['[render-process-gone]', { reason: 'oom' }]);
    assert.equal(w.count('reload'), 1, 'and the crash is still reloaded');
  });
});
