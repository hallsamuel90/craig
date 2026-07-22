import { positionRegionRows } from "./input/keyboard.js";
import type { Viewport } from "./layout.js";
import {
  renderCenterPaneRegion,
  renderCenterPaneTerminalRowPatch,
  type RenderedRegion,
  type RenderedRegionPatch,
} from "./render.js";
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
  terminalRowIndices: readonly number[] | null = null,
): CenterPaneUpdate | null {
  if (terminalRowIndices) {
    return buildTerminalRowUpdate(viewport, data, previous, centerOnly, terminalRowIndices);
  }

  const region = renderCenterPaneRegion(viewport, data, { centerOnly });
  if (!hasSameRegionGeometry(previous, region)) {
    return null;
  }

  return {
    output: positionRegionRows(region.rows, previous.rows, region.row, region.column),
    region,
  };
}

function buildTerminalRowUpdate(
  viewport: Viewport,
  data: ShellData,
  previous: RenderedRegion,
  centerOnly: boolean,
  terminalRowIndices: readonly number[],
): CenterPaneUpdate | null {
  const patch = renderCenterPaneTerminalRowPatch(viewport, data, terminalRowIndices, { centerOnly });
  if (!patch || !hasSamePatchGeometry(previous, patch)) {
    return null;
  }

  const rows = previous.rows.slice();
  const output = patch.rows.map(({ index, row }) => {
    if (rows[index] === row) {
      return "";
    }
    rows[index] = row;
    return `\u001B[${patch.row + index};${patch.column}H${row}`;
  }).join("");

  return {
    output,
    region: { row: patch.row, column: patch.column, width: patch.width, rows },
  };
}

function hasSameRegionGeometry(previous: RenderedRegion, next: RenderedRegion): boolean {
  return previous.row === next.row &&
    previous.column === next.column &&
    previous.width === next.width &&
    previous.rows.length === next.rows.length;
}

function hasSamePatchGeometry(previous: RenderedRegion, patch: RenderedRegionPatch): boolean {
  return previous.row === patch.row &&
    previous.column === patch.column &&
    previous.width === patch.width &&
    previous.rows.length === patch.rowCount;
}
