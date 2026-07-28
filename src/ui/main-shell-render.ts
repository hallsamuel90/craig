import { positionRegionRows } from "./input/keyboard.js";
import type { MainShellRegions, RenderedRegion } from "./render.js";

export type MainShellRegionName = keyof MainShellRegions;

export interface MainShellRegionUpdate {
  output: string;
  regions: MainShellRegions;
}

export function buildMainShellRegionUpdate(
  previous: MainShellRegions,
  next: MainShellRegions,
  names: readonly MainShellRegionName[],
): MainShellRegionUpdate | null {
  const regions = { ...previous };
  let output = "";

  for (const name of names) {
    const previousRegion = previous[name];
    const nextRegion = next[name];
    if (!hasSameRegionGeometry(previousRegion, nextRegion)) {
      return null;
    }
    if (!previousRegion || !nextRegion) {
      continue;
    }
    output += positionRegionRows(nextRegion.rows, previousRegion.rows, nextRegion.row, nextRegion.column);
    regions[name] = nextRegion;
  }

  return { output, regions };
}

function hasSameRegionGeometry(previous: RenderedRegion | null, next: RenderedRegion | null): boolean {
  if (!previous || !next) {
    return previous === next;
  }
  return previous.row === next.row &&
    previous.column === next.column &&
    previous.width === next.width &&
    previous.rows.length === next.rows.length;
}
