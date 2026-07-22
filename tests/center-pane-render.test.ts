import { describe, expect, test } from "vitest";

import { buildCenterPaneUpdate } from "../src/ui/center-pane-render.js";
import { MIN_VIEWPORT } from "../src/ui/layout.js";
import { getMockShellData } from "../src/ui/mock-data.js";
import { renderCenterPaneRegion } from "../src/ui/render.js";

describe("incremental center pane rendering", () => {
  test("writes terminal changes only at the center region column", () => {
    const initial = getMockShellData();
    const previous = renderCenterPaneRegion(MIN_VIEWPORT, initial);
    const next = {
      ...initial,
      terminal: {
        ...initial.terminal,
        rows: [{ segments: [{ text: "incremental output" }] }],
      },
    };

    const update = buildCenterPaneUpdate(MIN_VIEWPORT, next, previous, false);

    expect(update).not.toBeNull();
    expect(update?.output).toContain("incremental output");
    expect(update?.output).not.toContain("WORKSPACES");
    const cursorPattern = new RegExp(`${String.fromCharCode(27)}\\[\\d+;(\\d+)H`, "g");
    expect([...update!.output.matchAll(cursorPattern)].map((match) => match[1])).toEqual(["44"]);
  });

  test("requires a full repaint when center geometry changes", () => {
    const data = getMockShellData();
    const previous = renderCenterPaneRegion(MIN_VIEWPORT, data);

    expect(buildCenterPaneUpdate({ ...MIN_VIEWPORT, width: 140 }, data, previous, false)).toBeNull();
    expect(buildCenterPaneUpdate(MIN_VIEWPORT, data, previous, true)).toBeNull();
  });

  test("renders only the dirty terminal rows when geometry is stable", () => {
    const initial = getMockShellData({
      terminal: {
        status: "running",
        rows: ["first", "second", "third"].map((text) => ({ segments: [{ text }] })),
        error: null,
      },
    });
    const previous = renderCenterPaneRegion(MIN_VIEWPORT, initial);
    const next = {
      ...initial,
      terminal: {
        ...initial.terminal,
        rows: initial.terminal.rows.map((row, index) => index === 1
          ? { segments: [{ text: "second changed" }] }
          : row),
      },
    };

    const update = buildCenterPaneUpdate(MIN_VIEWPORT, next, previous, false, [1]);

    expect(update).not.toBeNull();
    expect(update?.output).toContain("second changed");
    expect(update?.output).not.toContain("first");
    expect(update?.output).not.toContain("third");
    const cursorPattern = new RegExp(`${String.fromCharCode(27)}\\[\\d+;(\\d+)H`, "g");
    expect([...update!.output.matchAll(cursorPattern)].map((match) => match[1])).toEqual(["44"]);
    expect(update?.region.rows[4]).toBe(previous.rows[4]);
    expect(update?.region.rows[6]).toBe(previous.rows[6]);
    expect(update?.region).toEqual(renderCenterPaneRegion(MIN_VIEWPORT, next));
  });

  test("falls back when a dirty row update cannot preserve center geometry", () => {
    const data = getMockShellData({
      terminal: { status: "running", rows: [{ segments: [{ text: "output" }] }], error: null },
    });
    const previous = renderCenterPaneRegion(MIN_VIEWPORT, data);

    expect(buildCenterPaneUpdate({ ...MIN_VIEWPORT, width: 140 }, data, previous, false, [0])).toBeNull();
    expect(buildCenterPaneUpdate(MIN_VIEWPORT, data, previous, false, [1])).toBeNull();
  });
});
