export interface Viewport {
  width: number;
  height: number;
}

export const MIN_VIEWPORT: Viewport = {
  width: 120,
  height: 36,
};

export const SHELL_LAYOUT = {
  leftWidth: 42,
  rightWidth: 36,
  dividerWidth: 1,
  topRailHeight: 1,
};

export function getViewport(width: number | undefined, height: number | undefined): Viewport {
  return {
    width: Math.max(width ?? MIN_VIEWPORT.width, MIN_VIEWPORT.width),
    height: Math.max(height ?? MIN_VIEWPORT.height, MIN_VIEWPORT.height),
  };
}

export interface PanelBounds {
  row: number;
  column: number;
  width: number;
  height: number;
}

// The preview's frames and terminal dimensions share these bounds. Pointer
// targeting can use the same rectangles when mouse interaction is introduced.
export function getFramedPanelBounds(viewport: Viewport, centerOnly = false) {
  const leftWidth = 32;
  const rightWidth = 34;
  const row = SHELL_LAYOUT.topRailHeight + 1;
  const height = viewport.height - SHELL_LAYOUT.topRailHeight - 1;
  const center: PanelBounds = {
    row, height,
    column: centerOnly ? 2 : leftWidth + 3,
    width: centerOnly ? viewport.width - 2 : viewport.width - leftWidth - rightWidth - 4,
  };
  return {
    left: centerOnly ? null : { row, height, column: 2, width: leftWidth },
    center,
    right: centerOnly ? null : { row, height, column: viewport.width - rightWidth, width: rightWidth },
  };
}

export function getFramedTerminalBounds(viewport: Viewport, centerOnly = false): PanelBounds {
  const center = getFramedPanelBounds(viewport, centerOnly).center;
  return {
    row: center.row + 2, // frame title, then task context
    column: center.column + 3, // border and two-column terminal gutter
    width: center.width - 6,
    height: center.height - 3, // title, context, bottom border
  };
}
