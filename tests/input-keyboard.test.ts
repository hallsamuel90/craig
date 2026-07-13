import { describe, expect, test } from "vitest";

import { positionFrameRows } from "../src/ui/input/keyboard.js";

describe("positionFrameRows", () => {
  test("positions only rows that differ from the preceding frame", () => {
    expect(positionFrameRows("first\nsecond\nthird", "first\nchanged\nthird")).toBe("[2;1Hsecond");
  });

  test("positions every row when no preceding frame is available", () => {
    expect(positionFrameRows("first\nsecond")).toBe("[1;1Hfirst[2;1Hsecond");
  });
});
