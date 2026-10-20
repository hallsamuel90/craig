import { describe, expect, test } from "vitest";

import { buildCenterPaneUpdate } from "../src/ui/center-pane-render.js";
import { MIN_VIEWPORT } from "../src/ui/layout.js";
import { getMockShellData } from "../src/ui/mock-data.js";
import { getPtySize } from "../src/ui/pty/session.js";
import { renderCenterPaneRegion } from "../src/ui/render.js";

describe("incremental center pane rendering", () => {
  test.each([
    { inputMode: "control", activeTab: "agent" },
    { inputMode: "terminal", activeTab: "agent" },
    { inputMode: "control", activeTab: "terminal" },
    { inputMode: "terminal", activeTab: "terminal" },
  ] as const)("preserves $activeTab borders through redraws in $inputMode mode", ({ inputMode, activeTab }) => {
    const initial = getMockShellData({ inputMode, activeTab, focusedRegion: "center", terminal: {
      status: "running", rows: [{ segments: [{ text: "before" }] }], error: null,
    } });
    const previous = renderCenterPaneRegion(MIN_VIEWPORT, initial, { panelPolish: true });
    const border = inputMode === "terminal" ? "\u001B[38;2;158;206;106;48;2;10;10;10m" : "\u001B[38;2;122;162;247;48;2;10;10;10m";
    expect(previous.rows[0]?.startsWith(`${border}╭─`)).toBe(true);
    expect(previous.rows.at(-1)?.startsWith(`${border}╰`)).toBe(true);
    for (const row of previous.rows.slice(1, -1)) {
      expect(row.startsWith(`${border}│`)).toBe(true);
      expect(row.endsWith(`${border}│\u001B[0m`)).toBe(true);
    }
    expect(previous.rows[0]).not.toContain("typing");
    const next = { ...initial, terminal: { ...initial.terminal, rows: [{ segments: [{ text: "after" }] }] } };
    const expected = renderCenterPaneRegion(MIN_VIEWPORT, next, { panelPolish: true });
    expect(buildCenterPaneUpdate(MIN_VIEWPORT, next, previous, false, null, true)?.region).toEqual(expected);
    expect(buildCenterPaneUpdate(MIN_VIEWPORT, next, previous, false, [0], true)?.region).toEqual(expected);
    const detached = { ...next, inputMode: "control" as const };
    const detachedView = buildCenterPaneUpdate(MIN_VIEWPORT, detached, expected, false, null, true)?.region;
    expect(detachedView?.rows[0]?.startsWith("\u001B[38;2;122;162;247;48;2;10;10;10m╭─")).toBe(true);
    expect(detachedView).toEqual(renderCenterPaneRegion(MIN_VIEWPORT, detached, { panelPolish: true }));
  });

  test.each([false, true])("preview PTY sizing keeps the last column and row inside the frame (zoom %s)", (centerOnly) => {
    const size = getPtySize(MIN_VIEWPORT, true, centerOnly);
    const terminalRows = Array.from({ length: size.rows + 1 }, (_, index) => ({ segments: [{ text: `${"x".repeat(size.columns - 1)}!` + (index === size.rows ? "hidden" : "") }] }));
    const data = getMockShellData({ terminal: { status: "running", rows: terminalRows, error: null } });
    const region = renderCenterPaneRegion(MIN_VIEWPORT, data, { color: false, panelPolish: true, centerOnly });
    expect(region.rows.length - 3).toBe(size.rows);
    expect(region.rows[2]).toBe(`│  ${"x".repeat(size.columns - 1)}!  │`);
    const colored = renderCenterPaneRegion(MIN_VIEWPORT, data, { panelPolish: true, centerOnly });
    const updated = buildCenterPaneUpdate(MIN_VIEWPORT, data, colored, centerOnly, [size.rows - 1, size.rows], true);
    expect(updated?.region).toEqual(colored);
    expect(region.rows.at(-1)).toMatch(/^╰─+╯$/);
    expect(region.rows.join("\n")).not.toContain("hidden");
  });

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
