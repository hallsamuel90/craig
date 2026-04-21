import { readFile, rm } from "node:fs/promises";

import { afterEach, describe, expect, test } from "vitest";

import { createTask } from "../src/services/create-task.js";
import { readTask } from "../src/state/task-store.js";
import { createCraigState, createRepoRoot, createStubCommands, getDateSegment } from "./test-helpers.js";

const tempRoots: string[] = [];
const originalPath = process.env.PATH ?? "";
const originalEnv = {
  CRAIG_TEST_GIT_EXISTING_BRANCHES: process.env.CRAIG_TEST_GIT_EXISTING_BRANCHES,
  CRAIG_TEST_GIT_WORKTREE_FAIL: process.env.CRAIG_TEST_GIT_WORKTREE_FAIL,
  CRAIG_TEST_TMUX_FAIL: process.env.CRAIG_TEST_TMUX_FAIL,
  CRAIG_TEST_TMUX_STATE_FILE: process.env.CRAIG_TEST_TMUX_STATE_FILE,
  CRAIG_TEST_TMUX_COMMAND_LOG: process.env.CRAIG_TEST_TMUX_COMMAND_LOG,
  CRAIG_TEST_TMUX_WINDOW_TARGET: process.env.CRAIG_TEST_TMUX_WINDOW_TARGET,
};

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map(async (root) => rm(root, { recursive: true, force: true })));
  process.env.PATH = originalPath;
  process.env.CRAIG_TEST_GIT_EXISTING_BRANCHES = originalEnv.CRAIG_TEST_GIT_EXISTING_BRANCHES;
  process.env.CRAIG_TEST_GIT_WORKTREE_FAIL = originalEnv.CRAIG_TEST_GIT_WORKTREE_FAIL;
  process.env.CRAIG_TEST_TMUX_FAIL = originalEnv.CRAIG_TEST_TMUX_FAIL;
  process.env.CRAIG_TEST_TMUX_STATE_FILE = originalEnv.CRAIG_TEST_TMUX_STATE_FILE;
  process.env.CRAIG_TEST_TMUX_COMMAND_LOG = originalEnv.CRAIG_TEST_TMUX_COMMAND_LOG;
  process.env.CRAIG_TEST_TMUX_WINDOW_TARGET = originalEnv.CRAIG_TEST_TMUX_WINDOW_TARGET;
});

describe("createTask", () => {
  test("creates a running task with runner-session metadata", async () => {
    const repoRoot = await createRepoRoot("craig-create-");
    tempRoots.push(repoRoot);
    const paths = await createCraigState(repoRoot);
    const stubDir = await createStubCommands(repoRoot);
    const tmuxStateFile = `${repoRoot}/tmux-state`;
    const tmuxCommandLog = `${repoRoot}/tmux-commands.log`;

    process.env.PATH = `${stubDir}:${originalPath}`;
    process.env.CRAIG_TEST_TMUX_STATE_FILE = tmuxStateFile;
    process.env.CRAIG_TEST_TMUX_COMMAND_LOG = tmuxCommandLog;

    const result = await createTask(paths, "refactor auth");
    const task = await readTask(paths, result.taskId);
    const tmuxCommands = await readFile(tmuxCommandLog, "utf8");

    expect(result.kind).toBe("createTask");
    expect(task.status).toBe("running");
    expect(task.runnerSession.command).toEqual(["cursor", "agent", "refactor auth"]);
    expect(task.runnerSession.lastKnownState).toBe("running");
    expect(task.runnerSession.startedAt).toBeTruthy();
    expect(task.tmuxTarget).toBe("%42");
    expect(task.artifacts.logPath).toBe(`.craig/logs/${result.taskId}.log`);
    expect(tmuxCommands).toContain("send-keys -t %42");
    expect(tmuxCommands).toContain("cursor agent 'refactor auth'");
  });

  test("creates panes against the resolved tmux window instead of assuming craig:0", async () => {
    const repoRoot = await createRepoRoot("craig-create-base-index-");
    tempRoots.push(repoRoot);
    const paths = await createCraigState(repoRoot);
    const stubDir = await createStubCommands(repoRoot);
    const tmuxStateFile = `${repoRoot}/tmux-state`;
    const tmuxCommandLog = `${repoRoot}/tmux-commands.log`;

    process.env.PATH = `${stubDir}:${originalPath}`;
    process.env.CRAIG_TEST_TMUX_STATE_FILE = tmuxStateFile;
    process.env.CRAIG_TEST_TMUX_COMMAND_LOG = tmuxCommandLog;
    process.env.CRAIG_TEST_TMUX_WINDOW_TARGET = "@9";

    await createTask(paths, "window lookup");

    const tmuxCommands = await readFile(tmuxCommandLog, "utf8");

    expect(tmuxCommands).toContain("new-session -d -P -F #{window_id} -s craig -n craig -c");
    expect(tmuxCommands).toContain("split-window -d -P -F #{pane_id} -t @9 -c");
  });

  test("allocates the next task id when the first branch already exists", async () => {
    const repoRoot = await createRepoRoot("craig-create-collision-");
    tempRoots.push(repoRoot);
    const paths = await createCraigState(repoRoot);
    const stubDir = await createStubCommands(repoRoot);
    const tmuxStateFile = `${repoRoot}/tmux-state`;
    const dateSegment = getDateSegment();

    process.env.PATH = `${stubDir}:${originalPath}`;
    process.env.CRAIG_TEST_TMUX_STATE_FILE = tmuxStateFile;
    process.env.CRAIG_TEST_GIT_EXISTING_BRANCHES = `refs/heads/craig/task_${dateSegment}_01`;

    const result = await createTask(paths, "branch collision");

    expect(result.taskId).toBe(`task_${dateSegment}_02`);
  });

  test("keeps a durable draft task when provisioning fails after allocation", async () => {
    const repoRoot = await createRepoRoot("craig-create-fail-");
    tempRoots.push(repoRoot);
    const paths = await createCraigState(repoRoot);
    const stubDir = await createStubCommands(repoRoot);

    process.env.PATH = `${stubDir}:${originalPath}`;
    process.env.CRAIG_TEST_TMUX_FAIL = "1";

    await expect(createTask(paths, "tmux missing")).rejects.toThrow(/tmux/);

    const tasks = await import("../src/services/list-tasks.js").then(({ listTasks }) => listTasks(paths));
    expect(tasks.tasks).toHaveLength(1);
    const failedTask = tasks.tasks[0];

    expect(failedTask).toBeDefined();
    expect(failedTask?.status).toBe("draft");
    expect(failedTask?.runnerSession.lastKnownState).toBe("failed");
    expect(failedTask?.lastFailureReason).toMatch(/tmux/);
  });
});
