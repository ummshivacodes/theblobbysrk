// The tiny right-click menu. It is generic: whoever opens it decides what the entries are, so this
// file knows nothing about tasks.
//   show(x, y, [{ label, className?, onSelect }])
// Choosing an entry closes the menu first, then runs its onSelect.
export function createRowMenu({ el, shell }) {
  const hide = () => { el.style.display = 'none'; };

  // Click anywhere else, or press Esc: it goes away.
  document.addEventListener('mousedown', (e) => { if (!el.contains(e.target)) hide(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hide(); });

  function show(x, y, items) {
    el.innerHTML = '';
    items.forEach(({ label, className, onSelect }) => {
      const button = document.createElement('button');
      if (className) button.className = className;
      button.textContent = label;
      button.onclick = () => { hide(); onSelect(); };
      el.appendChild(button);
    });
    el.style.display = 'block';
    const s = shell.getBoundingClientRect();
    const mw = el.offsetWidth;
    const mh = el.offsetHeight;
    el.style.left = `${Math.min(x - s.left, s.width - mw - 8)}px`;
    el.style.top = `${Math.min(y - s.top, s.height - mh - 8)}px`;
  }

  return { show, hide };
}
