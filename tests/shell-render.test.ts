import { describe, expect, test } from "vitest";

import { getMockShellData } from "../src/ui/mock-data.js";
import { MIN_VIEWPORT } from "../src/ui/layout.js";
import { renderBootOverlayFrame, renderMainShellFrame, renderPauseOverlayFrame } from "../src/ui/render.js";

describe("terminal shell renderer", () => {
  test("renders the boot overlay with the CRAIG logo and menu", () => {
    const frame = renderBootOverlayFrame(MIN_VIEWPORT, { color: false, menuIndex: 0 });

    expect(frame).toContain("▄████▄");
    expect(frame).toContain("crAIg is that you?");
    expect(frame).toContain("> Start");
    expect(frame).toContain("  Options");
    expect(frame).toContain("  Exit");
  });

  test("renders the pause overlay with resume and exit actions", () => {
    const frame = renderPauseOverlayFrame(MIN_VIEWPORT, { color: false, menuIndex: 0 });

    expect(frame).toContain("CRAIG paused");
    expect(frame).toContain("> Resume");
    expect(frame).toContain("  Options");
    expect(frame).toContain("  Exit");
  });

  test("renders the three-column mock workspace shell", () => {
    const frame = renderMainShellFrame(MIN_VIEWPORT, getMockShellData(), { color: false });

    expect(frame).toContain("CRAIG");
    expect(frame).toContain("~/workspaces/craig/colombo");
    expect(frame).toContain("CRAIG  |  ~/workspaces/craig/colombo  |  codex  ● live");
    expect(frame).not.toContain("4 tasks");
    expect(frame).not.toContain("v0.1.0");
    expect(frame).not.toContain("task/interactive-shell  |");
    expect(frame).toContain("WORKSPACES");
    expect(frame).toContain("+ New Task");
    expect(frame).toContain("+ New Workspace");
    expect(frame).toContain("RUNNERS");
    expect(frame).toContain("NORMAL   n new task");
    expect(frame).toContain("▸ task_20260430_02");
    expect(frame).toContain("running ●");
    expect(frame).toContain("AGENT");
    expect(frame).toContain("FILES");
    expect(frame).toContain("DIFF");
    expect(frame).toContain("TERMINAL");
    expect(frame).toContain("LOGS");
    expect(frame).toContain("CONTEXT");
    expect(frame).toContain("CHECKS");
    expect(frame).toContain("ACTIONS");
    expect(frame).toContain("NEXT");
    expect(frame).toContain("AGENT  task_20260430_02 · bug-fixes · codex");
    expect(frame).toContain("Press Enter on the AGENT");
    expect(frame).toContain("─────");
    expect(frame).not.toContain("│WORKSPACES");
  });

  test("renders selected mock state for tabs, tasks, actions, and placeholders", () => {
    const frame = renderMainShellFrame(
      MIN_VIEWPORT,
      getMockShellData({
        focusedRegion: "actions",
        selectedTaskId: "task_20260430_04",
        activeTab: "diff",
        selectedActionId: "push",
        actionMessage: "Mock action: push (phase 1.2).",
      }),
      { color: false },
    );

    expect(frame).toContain("▸ task_20260430_04");
    expect(frame).toContain("DIFF  task_20260430_04 · testing · codex");
    expect(frame).toContain("Diff surface placeholder for task_20260430");
    expect(frame).toContain("▸  push");
    expect(frame).toContain("Mock action: push (phase 1.2).");
  });

  test("renders the PTY terminal surface and terminal-mode hint", () => {
    const frame = renderMainShellFrame(
      MIN_VIEWPORT,
      getMockShellData({
        inputMode: "terminal",
        focusedRegion: "center",
        activeTab: "terminal",
        terminal: {
          status: "running",
          rows: [
            { segments: [{ text: "$ pwd" }] },
            { segments: [{ text: "/Users/samhall/conductor/workspaces/craig/boston-v2" }] },
          ],
          error: null,
        },
      }),
      { color: false },
    );

    expect(frame).toContain("TERMINAL  task_20260430_02 · bug-fixes");
    expect(frame).toContain("TERMINAL   Ctrl+] detach");
    expect(frame).toContain("$ pwd");
    expect(frame).toContain("/Users/samhall/conductor/workspaces/crai");
    expect(frame).not.toContain("terminal ▸ terminal mode");
  });

  test("renders recoverable PTY startup errors", () => {
    const frame = renderMainShellFrame(
      MIN_VIEWPORT,
      getMockShellData({
        activeTab: "terminal",
        terminal: {
          status: "failed",
          rows: [],
          error: "node-pty native module did not load",
        },
      }),
      { color: false },
    );

    expect(frame).toContain("terminal ▸ PTY unavailable");
    expect(frame).toContain("node-pty native module did not load");
    expect(frame).toContain("Fix the native dependency setup");
  });

  test("renders styled terminal emulator rows without breaking panel output", () => {
    const frame = renderMainShellFrame(
      MIN_VIEWPORT,
      getMockShellData({
        inputMode: "terminal",
        focusedRegion: "center",
        activeTab: "terminal",
        terminal: {
          status: "running",
          rows: [{ segments: [{ text: "green", style: { fg: "0dbc79" } }] }],
          error: null,
        },
      }),
      { color: true },
    );

    expect(frame).toContain("green");
    expect(frame).toContain("\u001B[38;2;13;188;121");
    expect(frame).not.toContain("terminal ▸ terminal mode");
    expect(frame).toContain("CONTEXT");
  });

  test("preserves full-width terminal background rows for PTY surfaces", () => {
    const frame = renderMainShellFrame(
      MIN_VIEWPORT,
      getMockShellData({
        inputMode: "terminal",
        focusedRegion: "center",
        activeTab: "agent",
        terminal: {
          status: "running",
          rows: [{ segments: [{ text: "> prompt", style: { fg: "e5e5e5", bg: "2a2a2a" } }] }],
          error: null,
        },
      }),
      { color: true },
    );

    expect(frame).toContain("> prompt");
    expect(frame).toContain("48;2;42;42;42");
  });

  test("renders PTY rows with a small horizontal gutter", () => {
    const frame = renderMainShellFrame(
      MIN_VIEWPORT,
      getMockShellData({
        inputMode: "terminal",
        focusedRegion: "center",
        activeTab: "agent",
        terminal: {
          status: "running",
          rows: [{ segments: [{ text: "gutter check" }] }],
          error: null,
        },
      }),
      { color: false },
    );

    expect(frame).toContain("  gutter check");
    expect(frame).not.toContain("agent ▸ terminal mode");
  });

  test("clips guttered PTY rows to the physical frame width", () => {
    const frame = renderMainShellFrame(
      MIN_VIEWPORT,
      getMockShellData({
        inputMode: "terminal",
        focusedRegion: "center",
        activeTab: "agent",
        terminal: {
          status: "running",
          rows: [{ segments: [{ text: "x".repeat(MIN_VIEWPORT.width) }] }],
          error: null,
        },
      }),
      { color: false },
    );

    expect(frame.split("\n").every((line) => line.length <= MIN_VIEWPORT.width)).toBe(true);
  });

  test("renders PTY rows without reapplying Craig center-pane colors after ANSI resets", () => {
    const frame = renderMainShellFrame(
      MIN_VIEWPORT,
      getMockShellData({
        inputMode: "terminal",
        focusedRegion: "center",
        activeTab: "agent",
        terminal: {
          status: "running",
          rows: [{ segments: [{ text: "codex", style: { fg: "29b8db" } }, { text: " output" }] }],
          error: null,
        },
      }),
      { color: true },
    );

    const promptLine = frame
      .split("\n")
      .find((line) => line.includes("\u001B[38;2;41;184;219;48;2;10;10;10mcodex"));

    expect(promptLine).toBeDefined();
    expect(promptLine).toContain("\u001B[38;2;41;184;219;48;2;10;10;10mcodex");
    expect(promptLine).not.toContain(
      "\u001B[38;2;230;230;230;48;2;10;10;10m\u001B[38;2;41;184;219m",
    );
    expect(promptLine).not.toContain(
      "\u001B[0m\u001B[38;2;230;230;230;48;2;10;10;10m output",
    );
  });
});
