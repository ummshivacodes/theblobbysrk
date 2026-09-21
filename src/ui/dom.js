// Tiny DOM helpers shared by the views. Deliberately small: there is no framework here, and the
// point is that a view reads as "build these elements", not as a wall of createElement calls.
const SVG_NS = 'http://www.w3.org/2000/svg';

// el('button', { className, text, title, dataset, onclick }) → an HTMLElement. Only the props the
// views actually use; text goes through textContent, never innerHTML.
export function el(tag, { className, text, title, dataset, onclick } = {}) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  if (title !== undefined) node.title = title;
  if (dataset) Object.assign(node.dataset, dataset);
  if (onclick) node.onclick = onclick;
  return node;
}

// svgEl('line', { x1: 0, ... }) → an SVG element with those attributes.
export function svgEl(name, attrs = {}) {
  const node = document.createElementNS(SVG_NS, name);
  Object.entries(attrs).forEach(([k, v]) => node.setAttribute(k, v));
  return node;
}
