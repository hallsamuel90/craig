import type { PanelBounds } from "../layout.js";

export type PointerAction =
  | { kind: "focus"; region: "tasks" | "center" | "inspector" }
  | { kind: "left" | "tab" | "inspection"; id: string }
  | { kind: "mode"; mode: "files" | "review" }
  | { kind: "engage" }
  | { kind: "menu"; index: number };

export interface HitTarget extends PanelBounds { action: PointerAction }

export function hitTest(targets: readonly HitTarget[], x: number, y: number): PointerAction | null {
  if (!Number.isInteger(x) || !Number.isInteger(y)) return null;
  return [...targets].reverse().find((target) => x >= target.column && x < target.column + target.width && y >= target.row && y < target.row + target.height)?.action ?? null;
}

export function pointerRegion(action: PointerAction): "tasks" | "center" | "inspector" | null {
  if (action.kind === "focus") return action.region;
  if (action.kind === "left") return "tasks";
  if (action.kind === "tab" || action.kind === "engage") return "center";
  if (action.kind === "inspection" || action.kind === "mode") return "inspector";
  return null;
}
