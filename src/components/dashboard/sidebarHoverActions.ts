/**
 * `AISidebar` keeps row actions mounted at opacity 0, so they still take label
 * width. On hover-capable devices, remove them from layout until the row is
 * hovered, focused or has its menu open. Mark own buttons `data-sidebar-reveal`;
 * the vendored "Actions for …" menu trigger is matched by its label. Touch
 * devices keep the always-visible menu.
 */
export const sidebarHoverActionsClassName =
  "[@media(hover:hover)]:[&_[role=treeitem]:not(:hover,:focus-within,[data-menu-open])_:is([data-sidebar-reveal],[aria-label^='Actions_for'])]:hidden";
