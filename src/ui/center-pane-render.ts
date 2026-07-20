import { positionRegionRows } from "./input/keyboard.js";
import type { Viewport } from "./layout.js";
import { renderCenterPaneRegion, type RenderedRegion } from "./render.js";
import type { ShellData } from "./shell/data.js";

export interface CenterPaneUpdate {
  output: string;
  region: RenderedRegion;
}

export function buildCenterPaneUpdate(
  viewport: Viewport,
  data: ShellData,
  previous: RenderedRegion,
  centerOnly: boolean,
): CenterPaneUpdate | null {
  const region = renderCenterPaneRegion(viewport, data, { centerOnly });
  if (!hasSameRegionGeometry(previous, region)) {
    return null;
  }

  return {
    output: positionRegionRows(region.rows, previous.rows, region.row, region.column),
    region,
  };
}

function hasSameRegionGeometry(previous: RenderedRegion, next: RenderedRegion): boolean {
  return previous.row === next.row &&
    previous.column === next.column &&
    previous.width === next.width &&
    previous.rows.length === next.rows.length;
}
