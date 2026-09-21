// The Settings screen's one setting: launch at login. The app object comes in
// through the factory, so this runs in plain Node under test.

function createSettings({ app, log = console }) {
  return {
    getLoginItem() {
      return app.getLoginItemSettings().openAtLogin;
    },

    // Returns the state the OS reports afterwards, not the one asked for, so the
    // toggle never lies if macOS refused the change.
    setLoginItem(on) {
      try {
        app.setLoginItemSettings({ openAtLogin: !!on });
      } catch (e) {
        log.warn('[login-item]', e.message);
      }
      return app.getLoginItemSettings().openAtLogin;
    },
  };
}

module.exports = { createSettings };
