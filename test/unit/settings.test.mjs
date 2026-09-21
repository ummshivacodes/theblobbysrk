import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createSettings } = require('../../main/settings.js');

// An app whose login-item state can be read, changed, refused or made to throw.
function fakeApp({ openAtLogin = false, refuse = false, throwOnSet = null } = {}) {
  const calls = [];
  const app = {
    calls,
    getLoginItemSettings: () => ({ openAtLogin }),
    setLoginItemSettings(settings) {
      calls.push(settings);
      if (throwOnSet) throw throwOnSet;
      if (!refuse) openAtLogin = settings.openAtLogin;
    },
  };
  return app;
}

const quietLog = () => {
  const warnings = [];
  return { warnings, warn: (...args) => warnings.push(args) };
};

test('getLoginItem reports what the OS says', () => {
  assert.equal(createSettings({ app: fakeApp({ openAtLogin: true }) }).getLoginItem(), true);
  assert.equal(createSettings({ app: fakeApp({ openAtLogin: false }) }).getLoginItem(), false);
});

test('setLoginItem asks the OS for a boolean and returns the state afterwards', () => {
  const app = fakeApp();
  const settings = createSettings({ app });
  assert.equal(settings.setLoginItem(true), true);
  assert.equal(settings.setLoginItem(false), false);
  assert.deepEqual(app.calls, [{ openAtLogin: true }, { openAtLogin: false }]);
});

test('whatever the page sends is turned into a boolean', () => {
  const app = fakeApp();
  const settings = createSettings({ app });
  for (const value of [1, 'yes', {}, [], 0, '', null, undefined, NaN]) settings.setLoginItem(value);
  assert.deepEqual(app.calls.map((c) => c.openAtLogin), [true, true, true, true, false, false, false, false, false]);
});

test('if the OS refuses the change, the answer is what it really is, so the toggle never lies', () => {
  const settings = createSettings({ app: fakeApp({ openAtLogin: false, refuse: true }) });
  assert.equal(settings.setLoginItem(true), false);
});

test('if the OS call throws, it is logged and the current state comes back instead of an error', () => {
  const log = quietLog();
  const settings = createSettings({ app: fakeApp({ openAtLogin: true, throwOnSet: new Error('not allowed') }), log });
  assert.equal(settings.setLoginItem(false), true);
  assert.deepEqual(log.warnings, [['[login-item]', 'not allowed']]);
});
