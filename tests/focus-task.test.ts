import { rm } from "node:fs/promises";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { createCraigState, createRepoRoot, writeTaskRecord } from "./test-helpers.js";

const tempRoots: string[] = [];
const focusPaneMock = vi.fn();

vi.mock("../src/services/tmux-session.js", () => ({
  focusPane: focusPaneMock,
}));

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map(async (root) => rm(root, { recursive: true, force: true })));
});

beforeEach(() => {
  focusPaneMock.mockReset();
});

describe("focusTask", () => {
  test("resolves a task id and focuses the pane", async () => {
    const repoRoot = await createRepoRoot("craig-focus-task-");
    tempRoots.push(repoRoot);
    const paths = await createCraigState(repoRoot);
    await writeTaskRecord(repoRoot, { id: "task_1", tmuxTarget: "%77" });

    const { focusTask } = await import("../src/services/focus-task.js");
    const result = await focusTask(paths, "task_1");

    expect(result.tmuxTarget).toBe("%77");
    expect(focusPaneMock).toHaveBeenCalledWith(repoRoot, "%77", "@1");
  });

  test("fails when the task does not have a tmux target", async () => {
    const repoRoot = await createRepoRoot("craig-focus-task-");
    tempRoots.push(repoRoot);
    const paths = await createCraigState(repoRoot);
    await writeTaskRecord(repoRoot, { id: "task_1", tmuxTarget: "" });

    const { focusTask } = await import("../src/services/focus-task.js");

    await expect(focusTask(paths, "task_1")).rejects.toThrow(/does not have a tmux target/);
  });
});
