import { el } from '../dom.js';
import { fmtWhen } from '../format.js';
import { COLORS } from '../theme.js';

// The ⚙ screen: the big crossed-off count, every task ever closed (kept in `history`, so it survives
// deleting the row), and the one real setting so far, launch at login. A history row also carries its
// own ↺: once a task has aged out of the main list (see selectors.js's DONE_VISIBLE_MS), this is the
// only way left to revive one that turns out to still be unfinished — the main list's own ↺ is gone by
// then along with the row.
//   els = { big, listed, list, listCount, loginToggle }; actions = { reopen(id) }; services = { settings }
export function createDoneView({ big, listed, list, listCount, loginToggle }, { reopen }, { settings }) {
  settings.getLoginItem().then((on) => { loginToggle.checked = !!on; });
  loginToggle.addEventListener('change', async () => {
    // Show what macOS actually did, so the toggle never lies if it refused.
    loginToggle.checked = !!(await settings.setLoginItem(loginToggle.checked));
  });

  function render(snapshot) {
    big.textContent = snapshot.stats.done;
    listed.textContent = snapshot.stats.listed;
    list.innerHTML = '';
    const rows = snapshot.history.slice().sort((a, b) => (b.doneAt || 0) - (a.doneAt || 0));
    listCount.textContent = `(${rows.length})`;
    if (rows.length === 0) {
      list.appendChild(el('div', { className: 'done-empty', text: 'Nothing crossed off yet.' }));
      return;
    }
    // A history entry outlives the task it describes — deleting a done row is allowed, and
    // deliberately doesn't touch history (see itemStore.js's deleteItem) — so ↺ has nothing left to
    // revive for one of those. reopen(id) would just silently no-op in that case; disabling the
    // button instead means the row says so up front rather than looking like it works and doing
    // nothing.
    const liveIds = new Set(snapshot.threads.map((t) => t.id));
    rows.forEach((h) => {
      const row = el('div', { className: 'task-row history' });
      row.appendChild(el('span', { className: 'task-text', text: h.text, title: h.text }));
      row.appendChild(el('span', { className: 'history-when', text: fmtWhen(h.doneAt) }));
      const chip = el('span', { className: `tag-chip q${h.quad} static`, text: h.quad ? `Q${h.quad}` : '–' });
      chip.style.setProperty('--c', COLORS[h.quad] || '#666');
      row.appendChild(chip);
      const revivable = liveIds.has(h.id);
      row.appendChild(el('button', {
        className: 'task-act undo',
        text: '↺',
        title: revivable ? 'Reopen (undo cross-off)' : "Can't reopen — this one was deleted",
        attrs: revivable ? {} : { disabled: true },
        onclick: (e) => { e.stopPropagation(); if (revivable) reopen(h.id); },
      }));
      list.appendChild(row);
    });
  }

  return { render };
}
