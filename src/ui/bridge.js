// The ONLY file that reads window.threadAxis (the IPC bridge exposed by preload.js). Everything else
// in the UI receives just the small piece of it that it needs, grouped by purpose, so no view can
// reach the whole Electron surface.
export function createBridge(api = window.threadAxis) {
  return {
    // Reading and writing the saved threads.
    persistence: {
      loadThreads: () => api.loadThreads(),
      saveThreads: (data) => api.saveThreads(data),
    },
    // Asking the window to change: the renderer measures itself and asks for that size.
    windowCtl: {
      resize: (width, height) => api.resize(width, height),
      hide: () => api.hide(),
      quit: () => api.quit(),
    },
    settings: {
      getLoginItem: () => api.getLoginItem(),
      setLoginItem: (on) => api.setLoginItem(on),
    },
    // Links: open one in the browser, and fetch the title of a page. Main checks every address again (http and
    // https only) whatever the page already checked.
    links: {
      openExternal: (url) => api.openExternal(url),
      fetchTitle: (url) => api.fetchTitle(url),
    },
    // The window telling us it was revealed (hotkey, tray, Dock) or hidden.
    lifecycle: {
      onShown: (cb) => api.onShown(cb),
      onHidden: (cb) => api.onHidden(cb),
    },
  };
}
