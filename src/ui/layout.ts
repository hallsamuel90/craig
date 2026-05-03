export interface Viewport {
  width: number;
  height: number;
}

export const MIN_VIEWPORT: Viewport = {
  width: 120,
  height: 36,
};

export const SHELL_LAYOUT = {
  leftWidth: 38,
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
