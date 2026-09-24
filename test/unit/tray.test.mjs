import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createTray, formatHotkey } = require('../../main/tray.js');

// Fakes for the three Electron pieces, recording what they were asked to do, and
// handlers that record how they were called.
function setup(overrides = {}) {
  const record = { images: [], trays: [], menus: [], calls: [] };

  const nativeImage = {
    createFromPath(path) {
      const image = { path, template: null, setTemplateImage(value) { image.template = value; } };
      record.images.push(image);
      return image;
    },
  };

  class Tray {
    constructor(icon) {
      this.icon = icon;
      this.tooltip = null;
      this.handlers = new Map();
      this.popups = [];
      record.trays.push(this);
    }
    setToolTip(text) { this.tooltip = text; }
    on(event, handler) { this.handlers.set(event, handler); }
    popUpContextMenu(menu) { this.popups.push(menu); }
  }

  const Menu = {
    buildFromTemplate(template) {
      const menu = { template };
      record.menus.push(menu);
      return menu;
    },
  };

  const handler = (name) => (...args) => record.calls.push([name, args.length]);
  const options = {
    Tray, Menu, nativeImage,
    iconPath: '/app/assets/blobTemplate.png',
    hotkeyLabel: '⌘⇧Y',
    onShow: handler('show'), onHide: handler('hide'), onToggle: handler('toggle'), onQuit: handler('quit'),
    ...overrides,
  };
  return { tray: createTray(options), record, options };
}

describe('createTray', () => {
  test('builds the icon from the given path, as a template image, and titles the tray "Blob — by SRK"', () => {
    const { tray, record } = setup();
    assert.equal(record.images.length, 1);
    assert.equal(record.images[0].path, '/app/assets/blobTemplate.png');
    assert.equal(record.images[0].template, true);
    assert.equal(record.trays.length, 1);
    assert.equal(tray, record.trays[0], 'the Tray is returned, for the caller to keep alive');
    assert.equal(tray.icon, record.images[0]);
    assert.equal(tray.tooltip, 'Blob — by SRK');
  });

  test('the menu has the same items, in the same order, as before', () => {
    const { record } = setup();
    assert.equal(record.menus.length, 1);
    const template = record.menus[0].template;
    assert.deepEqual(template.map(({ label, type, enabled }) => ({ label, type, enabled })), [
      { label: 'Show Blob', type: undefined, enabled: undefined },
      { label: 'Hide Blob', type: undefined, enabled: undefined },
      { label: undefined, type: 'separator', enabled: undefined },
      { label: 'Toggle: ⌘⇧Y', type: undefined, enabled: false },
      { label: undefined, type: 'separator', enabled: undefined },
      { label: 'Quit Blob', type: undefined, enabled: undefined },
    ]);
    assert.equal(template[3].click, undefined, 'the hotkey hint is a label, not a button');
  });

  test('the hotkey label is whatever the caller passes', () => {
    const { record } = setup({ hotkeyLabel: '⌃⌥K' });
    assert.equal(record.menus[0].template[3].label, 'Toggle: ⌃⌥K');
  });

  test('Show, Hide and Quit call their own handler, once, without Electron\'s event arguments', () => {
    const { record } = setup();
    const [show, hide, , , , quit] = record.menus[0].template;
    show.click({ menuItem: true }, { browserWindow: true }, { event: true });
    assert.deepEqual(record.calls, [['show', 0]]);
    hide.click({ menuItem: true }, {}, {});
    quit.click({ menuItem: true }, {}, {});
    assert.deepEqual(record.calls, [['show', 0], ['hide', 0], ['quit', 0]]);
  });

  test('left-click toggles', () => {
    const { tray, record } = setup();
    tray.handlers.get('click')({ shiftKey: false }, { x: 1, y: 2 }, { x: 3, y: 4 });
    assert.deepEqual(record.calls, [['toggle', 0]]);
  });

  test('right-click pops up the menu, and nothing else happens', () => {
    const { tray, record } = setup();
    tray.handlers.get('right-click')();
    assert.deepEqual(tray.popups, [record.menus[0]]);
    assert.deepEqual(record.calls, []);
  });

  test('only left-click and right-click are listened for', () => {
    const { tray } = setup();
    assert.deepEqual([...tray.handlers.keys()].sort(), ['click', 'right-click']);
  });

  test('nothing is triggered just by building the tray', () => {
    const { record } = setup();
    assert.deepEqual(record.calls, []);
  });
});

describe('formatHotkey', () => {
  test('on macOS, writes an accelerator the way the menu shows it', () => {
    assert.equal(formatHotkey('CommandOrControl+Shift+Y', 'darwin'), '⌘⇧Y');
  });

  test('on macOS, leaves the parts it does not know alone', () => {
    assert.equal(formatHotkey('Alt+K', 'darwin'), 'AltK');
    assert.equal(formatHotkey('CommandOrControl+Alt+Shift+Space', 'darwin'), '⌘Alt⇧Space');
    assert.equal(formatHotkey('F5', 'darwin'), 'F5');
  });

  test('on Windows and Linux, spells out Ctrl instead of a Mac glyph, keeping the + separators', () => {
    assert.equal(formatHotkey('CommandOrControl+Shift+Y', 'win32'), 'Ctrl+Shift+Y');
    assert.equal(formatHotkey('CommandOrControl+Shift+Y', 'linux'), 'Ctrl+Shift+Y');
  });

  test('leaves an accelerator with no CommandOrControl alone on other platforms too', () => {
    assert.equal(formatHotkey('Alt+K', 'win32'), 'Alt+K');
    assert.equal(formatHotkey('F5', 'win32'), 'F5');
  });

  test('defaults to process.platform when none is passed', () => {
    assert.equal(formatHotkey('CommandOrControl+Shift+Y'), formatHotkey('CommandOrControl+Shift+Y', process.platform));
  });
});
