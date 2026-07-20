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
});
