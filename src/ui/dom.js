// Tiny DOM helpers shared by the views. Deliberately small: there is no framework here, and the
// point is that a view reads as "build these elements", not as a wall of createElement calls.
const SVG_NS = 'http://www.w3.org/2000/svg';

// el('button', { className, text, title, dataset, attrs, onclick }) → an HTMLElement. Only the props
// the views actually use; text goes through textContent, never innerHTML. `attrs` is for plain
// attributes (placeholder, tabindex, aria-*): each value is stringified.
export function el(tag, { className, text, title, dataset, attrs, onclick } = {}) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  if (title !== undefined) node.title = title;
  if (dataset) Object.assign(node.dataset, dataset);
  if (attrs) Object.entries(attrs).forEach(([name, value]) => node.setAttribute(name, String(value)));
  if (onclick) node.onclick = onclick;
  return node;
}

// svgEl('line', { x1: 0, ... }) → an SVG element with those attributes.
export function svgEl(name, attrs = {}) {
  const node = document.createElementNS(SVG_NS, name);
  Object.entries(attrs).forEach(([k, v]) => node.setAttribute(k, v));
  return node;
}

// Fill `parent` with the pieces of some text as core/linkify split it: plain text as text nodes, each link as
// a clickable element. Built node by node, never from markup, so nothing a note contains can inject any.
// A link is deliberately NOT an <a href>: the page must never be able to navigate, so the click is handled
// here and handed to `onLink(href)`, which asks the main process (it checks the address again) to open it in
// the browser. Enter opens a focused link too.
export function renderSegments(parent, segments, { onLink }) {
  segments.forEach((segment) => {
    if (segment.type !== 'link') {
      parent.appendChild(document.createTextNode(segment.value));
      return;
    }
    const link = el('a', { className: 'link', text: segment.value, title: segment.href, attrs: { role: 'link', tabindex: 0 } });
    const open = (e) => {
      e.preventDefault();
      e.stopPropagation(); // a click on a link is not also a click on the row or the notes text around it
      onLink(segment.href);
    };
    link.addEventListener('click', open);
    link.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(e); });
    parent.appendChild(link);
  });
}
