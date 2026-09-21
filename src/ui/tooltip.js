// The small tooltip under the blob. Elements are passed in, so this file knows no ids.
export function createTooltip({ el, shell }) {
  return {
    show(anchor, text) {
      el.textContent = text;
      el.classList.add('show');
      // Centre under the anchor, clamped inside the shell.
      const o = anchor.getBoundingClientRect();
      const s = shell.getBoundingClientRect();
      const tw = el.offsetWidth;
      let left = o.left - s.left + o.width / 2 - tw / 2;
      left = Math.max(4, Math.min(left, s.width - tw - 4));
      el.style.left = `${left}px`;
    },
    hide() {
      el.classList.remove('show');
    },
  };
}
