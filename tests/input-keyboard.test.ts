import { describe, expect, test } from "vitest";

import { positionFrameRows, positionRegionRows } from "../src/ui/input/keyboard.js";

describe("positionFrameRows", () => {
  test("positions only rows that differ from the preceding frame", () => {
    expect(positionFrameRows("first\nsecond\nthird", "first\nchanged\nthird")).toBe("[2;1Hsecond");
  });

  test("positions every row when no preceding frame is available", () => {
    expect(positionFrameRows("first\nsecond")).toBe("[1;1Hfirst[2;1Hsecond");
  });
});

describe("positionRegionRows", () => {
  test("positions only changed region rows at the region column", () => {
    expect(positionRegionRows(["first", "second"], ["first", "changed"], 2, 44)).toBe("\u001B[3;44Hsecond");
  });
});
