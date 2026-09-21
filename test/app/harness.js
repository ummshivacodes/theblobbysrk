// Small helpers shared by the Electron tests: sleeping, polling, and a PASS/FAIL reporter.
// (Booting the app in isolation lives in scripts/lib/isolatedApp.js.)
const { isDeepStrictEqual } = require('util');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Poll `fn` (sync or async) until it returns something truthy. Resolves to that value, or to
// `false` on timeout. Tests wait on conditions like this, never on fixed sleeps: a fixed-timeline
// self-test already failed once on this machine just because it was under load.
async function waitFor(fn, ms = 4000, every = 40) {
  const t0 = Date.now();
  for (;;) {
    let v = false;
    try { v = await fn(); } catch { v = false; }
    if (v) return v;
    if (Date.now() - t0 >= ms) return false;
    await sleep(every);
  }
}

// One reporter per test run. finish() prints the verdict, cleans up and exits with 0/1; it is
// safe to call twice (the watchdog and a normal finish can race).
function createReporter({ app, cleanup, watchdogMs = 120 * 1000 }) {
  let failed = 0;
  let done = false;

  const check = (name, ok, extra = '') => {
    if (!ok) failed++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`);
    return !!ok;
  };

  // Deep-equality check that prints both sides when they differ.
  const expectEq = (name, actual, expected) => {
    const ok = isDeepStrictEqual(actual, expected);
    return check(name, ok, ok ? '' : `expected ${JSON.stringify(expected)} but got ${JSON.stringify(actual)}`);
  };

  const finish = () => {
    if (done) return;
    done = true;
    clearTimeout(watchdog);
    console.log(failed ? `\nRESULT: ${failed} check(s) FAILED` : '\nRESULT: all checks passed');
    cleanup();
    app.exit(failed ? 1 : 0);
  };

  const watchdog = setTimeout(() => {
    check('finished within the watchdog time', false);
    finish();
  }, watchdogMs);

  return { check, expectEq, finish, failed: () => failed };
}

module.exports = { sleep, waitFor, createReporter };
