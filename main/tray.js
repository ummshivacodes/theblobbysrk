// The menu-bar icon and its menu. The Electron pieces (Tray, Menu, nativeImage)
// and the four things the menu can ask for come in through the factory, so this
// runs under test with fakes.

// "CommandOrControl+Shift+Y" -> "⌘⇧Y", the way the menu shows it.
function formatHotkey(accelerator) {
  return accelerator.replace('CommandOrControl', '⌘').replace('Shift', '⇧').replace(/\+/g, '');
}

// Returns the Tray. The caller must keep it referenced: a Tray nothing points
// at is garbage-collected, and its icon quietly vanishes from the menu bar.
function createTray({ Tray, Menu, nativeImage, iconPath, hotkeyLabel, onShow, onHide, onToggle, onQuit }) {
  const icon = nativeImage.createFromPath(iconPath);
  icon.setTemplateImage(true);
  const tray = new Tray(icon);
  tray.setToolTip('Blob');

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
