import { el } from '../dom.js';
import { fmtWhen } from '../format.js';
import { COLORS } from '../theme.js';

// The ⚙ screen: the big crossed-off count, every task ever closed (kept in `history`, so it survives
// deleting the row), and the one real setting so far, launch at login.
//   els = { big, listed, list, listCount, loginToggle }; services = { settings }
export function createDoneView({ big, listed, list, listCount, loginToggle }, { settings }) {
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
    rows.forEach((h) => {
      const row = el('div', { className: 'task-row history' });
      row.appendChild(el('span', { className: 'task-text', text: h.text, title: h.text }));
      row.appendChild(el('span', { className: 'history-when', text: fmtWhen(h.doneAt) }));
      const chip = el('span', { className: `tag-chip q${h.quad} static`, text: h.quad ? `Q${h.quad}` : '–' });
      chip.style.setProperty('--c', COLORS[h.quad] || '#666');
      row.appendChild(chip);
      list.appendChild(row);
    });
  }

  return { render };
}
