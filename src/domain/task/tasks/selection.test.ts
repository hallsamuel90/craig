import { describe, it, expect } from "vitest";
import { sortTasksForDisplay, resolveSelectedTaskId } from "./selection.js";
import type { TaskRecord } from "../types.js";

const makeTask = (id: string, status: TaskRecord["status"], updatedAt = "2024-01-01T00:00:00.000Z"): TaskRecord => ({
  id,
  title: `Task ${id}`,
  slug: `task-${id}`,
  type: "repo",
  status,
  runner: "codex",
  repoId: "repo_1",
  workspaceId: "ws_1",
  sessionId: null,
  selectedPtyTabId: null,
  linkedRepoIds: [],
  repoRoot: "/repo",
  worktreePath: "/worktree",
  branch: `craig/${id}`,
  ptyTabs: [],
  runnerSession: { command: [], pid: null, startedAt: null, lastKnownState: "starting", exitCode: null, exitedAt: null },
  prompt: { source: "inline", value: "prompt" },
  checks: { source: { type: "repo_config", path: ".craig/config.json" }, lastRunAt: null, status: "not_run", commands: [], results: [] },
  lastCommit: null,
  prs: [],
  artifacts: { logPath: null, checkSummaryPath: null, prDraftPath: null, prStatusPath: null },
  cleanup: { paneClosedAt: null, worktreeRemovedAt: null, preservedWorktree: false, warning: null },
  createdAt: "2024-01-01T00:00:00.000Z",
  updatedAt,
});

describe("sortTasksForDisplay", () => {
  it("sorts tasks by id ascending", () => {
    const tasks = [makeTask("task_20240101_02", "draft"), makeTask("task_20240101_01", "draft")];
    const sorted = sortTasksForDisplay(tasks);
    expect(sorted.map((t) => t.id)).toEqual(["task_20240101_01", "task_20240101_02"]);
  });

  it("does not mutate the original array", () => {
    const tasks = [makeTask("task_20240101_02", "draft"), makeTask("task_20240101_01", "draft")];
    sortTasksForDisplay(tasks);
    expect(tasks[0]!.id).toBe("task_20240101_02");
  });
});

describe("resolveSelectedTaskId", () => {
  it("returns the previous selected id if still present", () => {
    const tasks = [makeTask("task_20240101_01", "draft"), makeTask("task_20240101_02", "draft")];
    expect(resolveSelectedTaskId(tasks, "task_20240101_02")).toBe("task_20240101_02");
  });

  it("returns null when tasks are empty", () => {
    expect(resolveSelectedTaskId([], "task_20240101_01")).toBeNull();
  });

  it("prioritizes merge_ready over draft", () => {
    const tasks = [
      makeTask("task_20240101_01", "draft"),
      makeTask("task_20240101_02", "merge_ready"),
    ];
    const selected = resolveSelectedTaskId(tasks, null);
    expect(selected).toBe("task_20240101_02");
  });

  it("falls back to most recently updated when priority matches", () => {
    const tasks = [
      makeTask("task_20240101_01", "draft", "2024-01-01T00:00:00.000Z"),
      makeTask("task_20240101_02", "draft", "2024-01-02T00:00:00.000Z"),
    ];
    const selected = resolveSelectedTaskId(tasks, null);
    expect(selected).toBe("task_20240101_02");
  });
});
