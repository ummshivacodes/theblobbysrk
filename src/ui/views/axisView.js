import { svgEl } from '../dom.js';
import { COLORS } from '../theme.js';
import { activeThreads, displayTitle } from '../../core/selectors.js';

// The axis: one bar per open thread. Keyed: each thread keeps its <g> across renders so a CSS
// transform transition can slide the existing bars over when a new one bundles in.
// `inset` is how far the baseline's own two ends sit in from the SVG's edges (ensureBase() below);
// buildDefs()'s groove filter region needs the SAME number, so it reads it from here rather than
// repeating the literal — two independent `10`s that happened to cancel out is exactly the kind of
// latent trap a reviewer audit caught (2026-09-22): safe today, one lone edit away from silently
// reintroducing the clipped-bar bug this file was just fixed for.
const AX = { w: 300, h: 120, baseline: 95, barHeight: 60, inset: 10 };

// The two drop-shadow filters. Built with svgEl rather than innerHTML, so nothing in the UI ever
// parses markup.
//
// Both are applied to a <line>: the bar itself is vertical (zero WIDTH), the baseline groove is
// horizontal (zero HEIGHT). A filter's region defaults to `objectBoundingBox` — a percentage of the
// filtered element's own bounding box — and a percentage of a zero-length side is still zero, so the
// region collapsed to nothing and clipped the shadow (and the bar's own colour) down to a thin white
// line. `userSpaceOnUse` with an explicit region, sized in the same coordinates the lines themselves
// use, fixes it for both: the fix is the region, not the shadow values, which are unchanged.
function buildDefs() {
  const defs = svgEl('defs');
  const { baseline, barHeight, w, inset } = AX;

  // Comfortably wider than the stroke (4.5) and the blur (stdDeviation 1.6) on every side.
  const RAISE_MARGIN = 15;
  const raise = svgEl('filter', {
    id: 'raise', filterUnits: 'userSpaceOnUse',
    x: -RAISE_MARGIN, y: baseline - barHeight - RAISE_MARGIN,
    width: RAISE_MARGIN * 2, height: barHeight + RAISE_MARGIN * 2,
  });
  raise.appendChild(svgEl('feDropShadow', {
    dx: 0, dy: 1.5, stdDeviation: 1.6, 'flood-color': '#000', 'flood-opacity': 0.55,
  }));

  // The groove's line runs from x=inset to x=w-inset at y=baseline (the same `inset` ensureBase() draws
  // it with); margin only needs to cover its own (smaller) blur.
  const GROOVE_MARGIN = 10;
  const groove = svgEl('filter', {
    id: 'groove', filterUnits: 'userSpaceOnUse',
    x: inset - GROOVE_MARGIN, y: baseline - GROOVE_MARGIN,
    width: w - inset * 2 + GROOVE_MARGIN * 2, height: GROOVE_MARGIN * 2,
  });
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
      x1: AX.inset, y1: AX.baseline, x2: AX.w - AX.inset, y2: AX.baseline,
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
