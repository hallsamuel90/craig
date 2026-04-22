import { describe, expect, test } from "vitest";

import { renderInteractiveLayout } from "../src/interactive/render-layout.js";
import { buildTaskRecord } from "./test-helpers.js";

describe("renderInteractiveLayout", () => {
  test("renders the three-zone layout on wide terminals", () => {
    const frame = renderInteractiveLayout({
      repoRoot: "/repo/seattle",
      tasks: [buildTaskRecord("/repo/seattle", { id: "task_1", title: "alpha" })],
      selectedTaskId: "task_1",
      hasSelectedTask: true,
      commandBuffer: "",
      outputLines: [],
      recentEvent: null,
      terminalSize: {
        columns: 120,
        rows: 28,
      },
    });

    expect(frame).toContain("seattle | 1 tasks | full-screen control surface");
    expect(frame).toContain("Tasks | 1");
    expect(frame).toContain("▄████▄");
    expect(frame).toContain("Selected Task");
    expect(frame).toContain("craig> █");
    expect(frame).toContain("Command Surface");
    expect(frame).toContain("r refresh");
    expect(frame).toContain("Enter: logs");
    expect(frame).toContain("Actions: show logs diff focus open check");
  });

  test("falls back to stacked sections on narrow terminals", () => {
    const frame = renderInteractiveLayout({
      repoRoot: "/repo/seattle",
      tasks: [],
      selectedTaskId: null,
      hasSelectedTask: false,
      commandBuffer: "",
      outputLines: [],
      recentEvent: null,
      terminalSize: {
        columns: 70,
        rows: 20,
      },
    });

    expect(frame).toContain("seattle | 0 tasks | full-screen control surface");
    expect(frame).toContain("Tasks | 0");
    expect(frame).toContain("No task selected.");
    expect(frame).toContain("Create a task with: new <task>");
    expect(frame).toContain("Enter run command | r refresh | Ctrl-L redraw | Ctrl-C exit");
  });

  test("shows selected-task help and suppresses the banner when content is dense", () => {
    const denseOutput = Array.from({ length: 8 }, (_, index) => `output line ${index}`);
    const frame = renderInteractiveLayout({
      repoRoot: "/repo/seattle",
      tasks: [buildTaskRecord("/repo/seattle", { id: "task_1", title: "alpha" })],
      selectedTaskId: "task_1",
      hasSelectedTask: true,
      commandBuffer: "",
      outputLines: denseOutput,
      recentEvent: "output line 0",
      terminalSize: {
        columns: 120,
        rows: 20,
      },
    });

    expect(frame).not.toContain("▄████▄");
    expect(frame).toContain("output line 0");
  });
});
