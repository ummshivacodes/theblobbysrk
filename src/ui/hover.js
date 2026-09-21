// Hover sync: hovering a core, a bar or a row lights up the other two. This module only owns WHICH id
// is hovered; each view repaints its own elements in applyHover(id). That is the whole point: no view
// reaches into another view's DOM (the old code did exactly that from one shared function).
export function createHover(views) {
  let hoveredId = null;
  return {
    get: () => hoveredId,
    set(id) {
      hoveredId = id;
      views.forEach((view) => view.applyHover(id));
    },
  };
}
