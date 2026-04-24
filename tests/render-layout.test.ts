import React from "react";
import { render } from "ink-testing-library";
import { describe, expect, test } from "vitest";

import { CraigScreen } from "../src/interactive/render-layout.js";
import { buildTaskRecord } from "./test-helpers.js";

const baseUiState = {
  version: 1 as const,
  selectedRepoId: null,
  selectedWorkspaceId: null,
  selectedTaskId: null,
  activeSurface: "shell" as const,
  overlayMode: "start" as const,
  inputMode: "control" as const,
  centerSurface: "command" as const,
  rightContextTab: "summary" as const,
  panelFocus: "left" as const,
  lastAttachedSessionId: null,
  commandBuffer: "",
  outputLines: [],
  updatedAt: "2026-04-24T00:00:00.000Z",
};

describe("CraigScreen", () => {
  test("renders the full three-column shell chrome at 160x48", () => {
    const task = buildTaskRecord("/workspace/seattle", { id: "task_1", title: "Refactor auth" });
    const view = render(
      React.createElement(CraigScreen, {
        workspaceRoot: "/workspace/seattle",
        repos: [
          {
            id: "repo_alpha",
            name: "alpha",
            rootPath: "/workspace/seattle/alpha",
            defaultBranch: "main",
            createdAt: "2026-04-23T00:00:00.000Z",
            updatedAt: "2026-04-23T00:00:00.000Z",
          },
        ],
        workspaces: [],
        archivedWorkspaces: [],
        tasks: [task],
        selectedTask: task,
        uiState: {
          ...baseUiState,
          selectedRepoId: "repo_alpha",
          selectedTaskId: "task_1",
        },
        overlayMenuIndex: 0,
        viewport: { columns: 160, rows: 48 },
      }),
    );

    const frame = view.lastFrame();
    expect(frame).toContain("CRAIG  /workspace/seattle  |  1 task  |  Agent live");
    expect(frame).toContain("TASKS");
    expect(frame).toContain("RUNNERS");
    expect(frame).toContain("TASK task_1: Refactor auth");
    expect(frame).toContain("Diff    Checks    PR");
    expect(frame).toContain("ACTIONS");
    expect(frame).toContain("CHECKS");
  });

  test("renders the compact shell at 120x36 with the context drawer", () => {
    const task = buildTaskRecord("/workspace/seattle", { id: "task_1", title: "Refactor auth" });
    const view = render(
      React.createElement(CraigScreen, {
        workspaceRoot: "/workspace/seattle",
        repos: [],
        workspaces: [],
        archivedWorkspaces: [],
        tasks: [task],
        selectedTask: task,
        uiState: {
          ...baseUiState,
          selectedTaskId: "task_1",
          rightContextTab: "files",
          panelFocus: "right",
        },
        overlayMenuIndex: 0,
        viewport: { columns: 120, rows: 36 },
      }),
    );

    const frame = view.lastFrame();
    expect(frame).toContain("TASK task_1: Refactor auth");
    expect(frame).toContain("Context tabs: summary | logs | diff | files | review");
    expect(frame).toContain("Context Drawer (files)");
    expect(frame).toContain("Open the selected task worktree for the full file list.");
  });

  test("renders the boot overlay over the shell frame", () => {
    const view = render(
      React.createElement(CraigScreen, {
        workspaceRoot: "/workspace/seattle",
        repos: [],
        workspaces: [],
        archivedWorkspaces: [],
        tasks: [],
        selectedTask: null,
        uiState: {
          ...baseUiState,
          activeSurface: "overlay",
        },
        overlayMenuIndex: 0,
        viewport: { columns: 160, rows: 48 },
      }),
    );

    const frame = view.lastFrame();
    expect(frame).toContain("CRAIG  /workspace/seattle  |  0 tasks  |  Agent live");
    expect(frame).toContain("c r A I g   i s   t h a t   y o u ?");
    expect(frame).toContain("> Start");
    expect(frame).toContain("Archives");
    expect(frame).toContain("[ ^/v navigate   enter select   esc back ]");
  });

  test("renders a resize overlay below the supported floor", () => {
    const view = render(
      React.createElement(CraigScreen, {
        workspaceRoot: "/workspace/seattle",
        repos: [],
        workspaces: [],
        archivedWorkspaces: [],
        tasks: [],
        selectedTask: null,
        uiState: baseUiState,
        overlayMenuIndex: 0,
        viewport: { columns: 100, rows: 30 },
      }),
    );

    const frame = view.lastFrame();
    expect(frame).toContain("Resize the terminal to continue.");
    expect(frame).toContain("Minimum size: 120x36");
    expect(frame).toContain("Current size: 100x30");
  });
});
