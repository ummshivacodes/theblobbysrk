// The menu-bar icon and its menu. The Electron pieces (Tray, Menu, nativeImage)
// and the four things the menu can ask for come in through the factory, so this
// runs under test with fakes.

// "CommandOrControl+Shift+Y" -> "⌘⇧Y" on macOS (the way the menu shows it), or "Ctrl+Shift+Y"
// elsewhere: Windows and Linux have no single-glyph stand-in for Cmd, so the compact symbol
// style would show a Mac key that does not exist on the tester's keyboard. platform is a
// parameter, not read from process.platform directly, so this stays a pure, testable function.
function formatHotkey(accelerator, platform = process.platform) {
  if (platform === 'darwin') {
    return accelerator.replace('CommandOrControl', '⌘').replace('Shift', '⇧').replace(/\+/g, '');
  }
  return accelerator.replace('CommandOrControl', 'Ctrl');
}

// Returns the Tray. The caller must keep it referenced: a Tray nothing points
// at is garbage-collected, and its icon quietly vanishes from the menu bar.
function createTray({ Tray, Menu, nativeImage, iconPath, hotkeyLabel, onShow, onHide, onToggle, onQuit }) {
  const icon = nativeImage.createFromPath(iconPath);
  icon.setTemplateImage(true);
  const tray = new Tray(icon);
  tray.setToolTip('Blob — by SRK'); // a native OS tooltip: plain text only, no smaller "by SRK" possible here

  // The handlers are wrapped so Electron's event arguments never reach them.
  const menu = Menu.buildFromTemplate([
    { label: 'Show Blob', click: () => onShow() },
    { label: 'Hide Blob', click: () => onHide() },
    { type: 'separator' },
    { label: `Toggle: ${hotkeyLabel}`, enabled: false },
    { type: 'separator' },
    { label: 'Quit Blob', click: () => onQuit() },
  ]);
  tray.on('click', () => onToggle());                    // left-click toggles
  tray.on('right-click', () => tray.popUpContextMenu(menu));
  return tray;
}

module.exports = { createTray, formatHotkey };
