import { el } from '../dom.js';
import { COLORS } from '../theme.js';
import { activeThreads } from '../../core/selectors.js';

// The blob: one glass orb for all open threads, with a coloured core dot per thread (up to four,
// then a "+n"). No open threads shows a dashed ghost orb.
const MAX_CORES = 4;

// els = { bar }; actions = { showTooltip(anchor, text), hideTooltip(), openFromBlob() }
export function createOrbView({ bar }, actions) {
  function render(snapshot, ui) {
    bar.innerHTML = '';
    const active = activeThreads(snapshot);

    const blob = el('div', { className: 'orb' });
    if (active.length === 0) blob.classList.add('ghost');
    if (active.some((t) => t.focused)) blob.classList.add('focused');

    active.slice(0, MAX_CORES).forEach((t) => {
      const core = el('div', { className: 'core', dataset: { id: t.id } });
      core.style.setProperty('--c', COLORS[t.quad] || '#999');
      if (t.focused) core.classList.add('focused');
      if (t.status === 'resolving') core.classList.add('resolving');
      if (t.id === ui.hoveredId) core.classList.add('hovered');
      blob.appendChild(core);
    });
    if (active.length > MAX_CORES) {
      blob.appendChild(el('div', { className: 'more', text: `+${active.length - MAX_CORES}` }));
    }

    const score = `${active.length} active · ${snapshot.stats.done}/${snapshot.stats.listed} done`;
    const tip = active.length === 0
      ? score
      : `${score}  —  ${active.map((t) => t.text).join(' · ')}`;
    blob.addEventListener('mouseenter', () => actions.showTooltip(blob, tip));
    blob.addEventListener('mouseleave', () => actions.hideTooltip());
    blob.addEventListener('click', (e) => {
      e.stopPropagation();
      actions.openFromBlob();
    });
    bar.appendChild(blob);
  }

  // Hover sync repaints only this view's own elements.
  function applyHover(id) {
    bar.querySelectorAll('.core[data-id]').forEach((core) => {
      core.classList.toggle('hovered', core.dataset.id === id);
    });
  }

  return { render, applyHover };
}
