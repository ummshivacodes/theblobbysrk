import { svgEl } from '../dom.js';
import { COLORS } from '../theme.js';
import { activeThreads, displayTitle } from '../../core/selectors.js';

// The axis: one bar per open thread. Keyed: each thread keeps its <g> across renders so a CSS
// transform transition can slide the existing bars over when a new one bundles in.
const AX = { w: 300, h: 120, baseline: 95, barHeight: 60 };

// The two drop-shadow filters. Built with svgEl rather than innerHTML, so nothing in the UI ever
// parses markup.
function buildDefs() {
  const defs = svgEl('defs');
  const raise = svgEl('filter', { id: 'raise', x: '-50%', y: '-20%', width: '200%', height: '140%' });
  raise.appendChild(svgEl('feDropShadow', {
    dx: 0, dy: 1.5, stdDeviation: 1.6, 'flood-color': '#000', 'flood-opacity': 0.55,
  }));
  const groove = svgEl('filter', { id: 'groove', x: '-5%', y: '-100%', width: '110%', height: '300%' });
  groove.appendChild(svgEl('feDropShadow', {
    dx: 0, dy: 1, stdDeviation: 0.8, 'flood-color': '#000', 'flood-opacity': 0.5,
  }));
  defs.appendChild(raise);
  defs.appendChild(groove);
  return defs;
}

// els = { svg, count }; actions = { resolve(id), hover(id | null) }
export function createAxisView({ svg, count }, actions) {
  // A bar's <g> outlives the snapshot it was drawn from, so click handlers look the thread up in the
  // LATEST snapshot instead of trusting the one they were created with.
  let latest = { threads: [] };

  function ensureBase() {
    if (svg.querySelector('#axisBase')) return;
    svg.appendChild(buildDefs());
    const base = svgEl('g', { id: 'axisBase' });
    base.appendChild(svgEl('line', {
      x1: 10, y1: AX.baseline, x2: AX.w - 10, y2: AX.baseline,
      stroke: 'rgba(255,255,255,0.28)', 'stroke-width': 1.5, filter: 'url(#groove)',
    }));
    svg.appendChild(base);
  }

  function fillBar(g, t, hoveredId) {
    const { baseline, barHeight } = AX;
    g.innerHTML = '';
    g.setAttribute('class',
      'bar-g' +
      (t.id === hoveredId ? ' hovered' : '') +
      (t.focused ? ' focused' : '') +
      (t.status === 'resolving' ? ' resolving' : ''));

    // Gold ring for the focused thread: a wider gold line drawn under the bar.
    if (t.focused) {
      g.appendChild(svgEl('line', {
        x1: 0, y1: baseline + 2, x2: 0, y2: baseline - barHeight - 2,
        'stroke-width': 10, class: 'halo', 'stroke-linecap': 'round',
      }));
    }

    // The bar itself: round-capped, drop-shadowed so it reads as a pin standing proud of the
    // baseline, plus a thin highlight down one edge.
    g.appendChild(svgEl('line', {
      x1: 0, y1: baseline, x2: 0, y2: baseline - barHeight,
      stroke: COLORS[t.quad] || '#999', 'stroke-width': 4.5,
      'stroke-linecap': 'round', class: 'bar', filter: 'url(#raise)',
    }));
    g.appendChild(svgEl('line', {
      x1: -1.2, y1: baseline - 2, x2: -1.2, y2: baseline - barHeight + 1,
      stroke: 'rgba(255,255,255,0.45)', 'stroke-width': 1, 'stroke-linecap': 'round', class: 'bar-sheen',
    }));

    if (t.status === 'resolving') {
      g.appendChild(svgEl('line', {
        x1: -10, y1: baseline - barHeight / 2 - 10, x2: 10, y2: baseline - barHeight / 2 + 10,
        stroke: '#8fd08f', 'stroke-width': 3, 'stroke-linecap': 'round', class: 'strike',
      }));
    }

    const label = svgEl('text', {
      x: 0, y: baseline - barHeight - 8, 'text-anchor': 'middle', class: 'thread-label',
    });
    const shown = displayTitle(t).label; // a link reads as its page title, not as https://www.…
    label.textContent = shown.length > 12 ? `${shown.slice(0, 11)}…` : shown;
    g.appendChild(label);
  }

  function render(snapshot, ui) {
    latest = snapshot;
    ensureBase();
    const threads = activeThreads(snapshot);
    count.textContent = `(${threads.length})`;

    const gap = (AX.w - 40) / Math.max(threads.length, 1);
    const keep = new Set(threads.map((t) => t.id));

    // Drop bars whose thread is gone (closed, recalled or deleted).
    svg.querySelectorAll('g.bar-g').forEach((g) => {
      if (!keep.has(g.dataset.id)) g.remove();
    });

    threads.forEach((t, i) => {
      const x = 25 + i * gap;
      let g = svg.querySelector(`g.bar-g[data-id="${t.id}"]`);
      const fresh = !g;
      if (fresh) {
        g = svgEl('g');
        g.dataset.id = t.id;
        g.style.cursor = 'pointer';
        g.addEventListener('click', () => {
          const current = latest.threads.find((x2) => x2.id === t.id);
          if (current && current.status === 'axis') actions.resolve(t.id);
        });
        g.addEventListener('mouseenter', () => actions.hover(t.id));
        g.addEventListener('mouseleave', () => actions.hover(null));
        // Start at its slot with no transition, then pop up from the baseline.
        g.style.transition = 'none';
        g.style.transform = `translateX(${x}px)`;
        svg.appendChild(g);
      }
      fillBar(g, t, ui.hoveredId);
      if (fresh) {
        g.classList.add('fresh');
        void g.getBoundingClientRect();
        g.style.transition = '';
      }
      g.style.transform = `translateX(${x}px)`;
    });
  }

  // Hover sync repaints only this view's own elements.
  function applyHover(id) {
    svg.querySelectorAll('.bar-g').forEach((g) => {
      g.classList.toggle('hovered', g.dataset.id === id);
    });
  }

  return { render, applyHover };
}
