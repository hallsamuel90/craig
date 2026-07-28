import { describe, expect, test } from "vitest";

import { buildMainShellRegionUpdate } from "../src/ui/main-shell-render.js";
import type { MainShellRegions, RenderedRegion } from "../src/ui/render.js";

describe("main shell regional rendering", () => {
  test("updates only requested regions and retains the rest of the physical cache", () => {
    const previous = getRegions("old");
    const next = getRegions("new");

    const update = buildMainShellRegionUpdate(previous, next, ["left", "center"]);

    expect(update?.output).toBe("\u001B[2;1Hleft new\u001B[2;44Hcenter new");
    expect(update?.regions.left?.rows).toEqual(["left new"]);
    expect(update?.regions.center.rows).toEqual(["center new"]);
    expect(update?.regions.right?.rows).toEqual(["right old"]);
    expect(update?.regions.rail.rows).toEqual(["rail old"]);
  });

  test("returns no output for unchanged rows", () => {
    const regions = getRegions("same");

    expect(buildMainShellRegionUpdate(regions, regions, ["rail", "left", "center", "right", "footer"])).toEqual({
      output: "",
      regions,
    });
  });

  test("falls back when a requested region changes geometry", () => {
    const previous = getRegions("old");
    const next = getRegions("new");
    next.center = { ...next.center, width: next.center.width + 1 };

    expect(buildMainShellRegionUpdate(previous, next, ["center"])).toBeNull();
  });
});

function getRegions(label: string): MainShellRegions {
  return {
    rail: region(1, 1, 120, `rail ${label}`),
    left: region(2, 1, 43, `left ${label}`),
    center: region(2, 44, 40, `center ${label}`),
    right: region(2, 84, 37, `right ${label}`),
    footer: region(36, 1, 120, `footer ${label}`),
  };
}

function region(row: number, column: number, width: number, value: string): RenderedRegion {
  return { row, column, width, rows: [value] };
}
