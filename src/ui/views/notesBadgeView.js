import { noteCount } from '../../core/selectors.js';

// The header's N button: the letter and how many notes there are. When the number goes UP it pulses once,
// so a note filed from the list (the row leaves it) or captured with ⌘↵ visibly lands somewhere. Deciding
// to pulse from the count, not from what the user did, means every way of adding a note pulses the same
// way, and loading the saved notes at startup (no previous count) does not.
//   els = { button, count }
export function createNotesBadgeView({ button, count }) {
  let shown = null; // the count drawn last; null until the first draw

  button.addEventListener('animationend', () => button.classList.remove('pulse'));

  function render(snapshot) {
    const n = noteCount(snapshot);
    count.textContent = n > 0 ? String(n) : '';
    button.title = n === 1 ? 'Notes (1)' : n > 1 ? `Notes (${n})` : 'Notes';
    if (shown !== null && n > shown) {
      button.classList.remove('pulse');
      void button.offsetWidth; // restart the animation if it was still running
      button.classList.add('pulse');
    }
    shown = n;
  }

  return { render };
}
