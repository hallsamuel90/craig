import { rm } from "node:fs/promises";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { createCraigState, createRepoRoot, writeSessionRecord, writeTaskRecord } from "./test-helpers.js";

const tempRoots: string[] = [];

const mocks = vi.hoisted(() => ({
  focusPane: vi.fn(),
}));

vi.mock("../src/domain/task/adapters/tmux.js", () => ({
  focusPane: mocks.focusPane,
}));

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map(async (root) => rm(root, { recursive: true, force: true })));
});

beforeEach(() => {
  mocks.focusPane.mockReset();
});

describe("focusTask", () => {
  test("resolves a task session and focuses the pane", async () => {
    const repoRoot = await createRepoRoot("craig-focus-task-");
    tempRoots.push(repoRoot);
    const paths = await createCraigState(repoRoot);
    await writeTaskRecord(repoRoot, { id: "task_1", sessionId: "session_task_1" });
    await writeSessionRecord(repoRoot, {
      id: "session_task_1",
      taskId: "task_1",
      sessionName: "craig-test-task_1",
      paneId: "%77",
      windowTarget: "@1",
    });

    const { taskService } = await import("../src/domain/task/index.js");
    const result = await taskService.focusTask(paths, "task_1");

    expect(result.tmuxTarget).toBe("%77");
    expect(mocks.focusPane).toHaveBeenCalledWith(repoRoot, "%77", "@1", "craig-test-task_1");
  });

  test("fails when the task does not have a Craig session", async () => {
    const repoRoot = await createRepoRoot("craig-focus-task-");
    tempRoots.push(repoRoot);
    const paths = await createCraigState(repoRoot);
    await writeTaskRecord(repoRoot, { id: "task_1", sessionId: null });

    const { taskService } = await import("../src/domain/task/index.js");

    await expect(taskService.focusTask(paths, "task_1")).rejects.toThrow(/does not have a Craig session/);
  });
});
