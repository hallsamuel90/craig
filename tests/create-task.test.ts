import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { createTask } from "../src/services/create-task.js";
import { getSessionNameForRepo } from "../src/services/tmux-session.js";
import { readSession } from "../src/state/session-store.js";
import { readTask } from "../src/state/task-store.js";
import {
  createCraigState,
  createRepoRoot,
  createStubCommands,
  getDateSegment,
  writeRepoRecord,
} from "./test-helpers.js";

const tempRoots: string[] = [];
const originalPath = process.env.PATH ?? "";
const originalStdoutColumns = Object.getOwnPropertyDescriptor(process.stdout, "columns");
const originalStdoutRows = Object.getOwnPropertyDescriptor(process.stdout, "rows");
const originalEnv = {
  CRAIG_TEST_GIT_EXISTING_BRANCHES: process.env.CRAIG_TEST_GIT_EXISTING_BRANCHES,
  CRAIG_TEST_GIT_WORKTREE_FAIL: process.env.CRAIG_TEST_GIT_WORKTREE_FAIL,
  CRAIG_TEST_TMUX_FAIL: process.env.CRAIG_TEST_TMUX_FAIL,
  CRAIG_TEST_TMUX_SPLIT_FAIL: process.env.CRAIG_TEST_TMUX_SPLIT_FAIL,
  CRAIG_TEST_TMUX_NEW_WINDOW_PANE_ID: process.env.CRAIG_TEST_TMUX_NEW_WINDOW_PANE_ID,
  CRAIG_TEST_TMUX_STATE_FILE: process.env.CRAIG_TEST_TMUX_STATE_FILE,
  CRAIG_TEST_TMUX_COMMAND_LOG: process.env.CRAIG_TEST_TMUX_COMMAND_LOG,
  CRAIG_TEST_TMUX_WINDOW_TARGET: process.env.CRAIG_TEST_TMUX_WINDOW_TARGET,
};

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map(async (root) => rm(root, { recursive: true, force: true })));
  process.env.PATH = originalPath;
  restoreStreamDimension(process.stdout, "columns", originalStdoutColumns);
  restoreStreamDimension(process.stdout, "rows", originalStdoutRows);
  process.env.CRAIG_TEST_GIT_EXISTING_BRANCHES = originalEnv.CRAIG_TEST_GIT_EXISTING_BRANCHES;
  process.env.CRAIG_TEST_GIT_WORKTREE_FAIL = originalEnv.CRAIG_TEST_GIT_WORKTREE_FAIL;
  process.env.CRAIG_TEST_TMUX_FAIL = originalEnv.CRAIG_TEST_TMUX_FAIL;
  process.env.CRAIG_TEST_TMUX_SPLIT_FAIL = originalEnv.CRAIG_TEST_TMUX_SPLIT_FAIL;
  process.env.CRAIG_TEST_TMUX_NEW_WINDOW_PANE_ID = originalEnv.CRAIG_TEST_TMUX_NEW_WINDOW_PANE_ID;
  process.env.CRAIG_TEST_TMUX_STATE_FILE = originalEnv.CRAIG_TEST_TMUX_STATE_FILE;
  process.env.CRAIG_TEST_TMUX_COMMAND_LOG = originalEnv.CRAIG_TEST_TMUX_COMMAND_LOG;
  process.env.CRAIG_TEST_TMUX_WINDOW_TARGET = originalEnv.CRAIG_TEST_TMUX_WINDOW_TARGET;
});

describe("createTask", () => {
  test("creates a running task with workspace-scoped session metadata", async () => {
    const workspaceRoot = await createRepoRoot("craig-create-");
    const { paths, repoRoot, repoId, workspaceId } = await setupRegisteredRepo(workspaceRoot, "repo-a");
    const stubDir = await createStubCommands(workspaceRoot);
    const tmuxStateFile = `${workspaceRoot}/tmux-state`;
    const tmuxCommandLog = `${workspaceRoot}/tmux-commands.log`;

    process.env.PATH = `${stubDir}:${originalPath}`;
    process.env.CRAIG_TEST_TMUX_STATE_FILE = tmuxStateFile;
    process.env.CRAIG_TEST_TMUX_COMMAND_LOG = tmuxCommandLog;

    const result = await createTask(paths, repoId, "refactor auth");
    const task = await readTask(paths, result.taskId);
    const session = await readSession(paths, result.sessionId);
    const tmuxCommands = await readFile(tmuxCommandLog, "utf8");

    expect(result.kind).toBe("createTask");
    expect(result.repoId).toBe(repoId);
    expect(task.status).toBe("running");
    expect(task.runner).toBe("codex");
    expect(task.repoId).toBe(repoId);
    expect(task.workspaceId).toBe(workspaceId);
    expect(task.sessionId).toBe(result.sessionId);
    expect(task.runnerSession.command).toEqual(["codex", "refactor auth"]);
    expect(task.runnerSession.lastKnownState).toBe("running");
    expect(task.tmuxTarget).toBe("%42");
    expect(task.tmuxWindowTarget).toBe("@0");
    expect(task.tmuxPage).toBe(1);
    expect(task.worktreePath).toBe(path.join(paths.worktreesDir, repoId, result.taskId));
    expect(session.repoId).toBe(repoId);
    expect(session.taskId).toBe(result.taskId);
    expect(session.worktreePath).toBe(task.worktreePath);
    expect(tmuxCommands).toContain("resize-pane -t %1 -y 8");
    expect(tmuxCommands).toContain("select-layout -t @0 tiled");
    expect(tmuxCommands).toContain("send-keys -t %42");
    expect(tmuxCommands).toContain("codex 'refactor auth'");
    expect(getSessionNameForRepo(repoRoot)).toBe(session.sessionName);
  });

  test("creates panes against the resolved tmux window instead of assuming craig:0", async () => {
    const workspaceRoot = await createRepoRoot("craig-create-base-index-");
    const { paths, repoRoot, repoId } = await setupRegisteredRepo(workspaceRoot, "repo-a");
    const stubDir = await createStubCommands(workspaceRoot);
    const tmuxStateFile = `${workspaceRoot}/tmux-state`;
    const tmuxCommandLog = `${workspaceRoot}/tmux-commands.log`;

    process.env.PATH = `${stubDir}:${originalPath}`;
    process.env.CRAIG_TEST_TMUX_STATE_FILE = tmuxStateFile;
    process.env.CRAIG_TEST_TMUX_COMMAND_LOG = tmuxCommandLog;
    process.env.CRAIG_TEST_TMUX_WINDOW_TARGET = "@9";

    await createTask(paths, repoId, "window lookup");

    const tmuxCommands = await readFile(tmuxCommandLog, "utf8");
    const sessionName = getSessionNameForRepo(repoRoot);

    expect(tmuxCommands).toContain(`new-session -d -P -F #{window_id} #{pane_id} -s ${sessionName} -n ${sessionName} -c`);
    expect(tmuxCommands).toContain("split-window -d -P -F #{pane_id} -t @9 -c");
    expect(tmuxCommands).toContain("select-layout -t @9 tiled");
  });

  test("sizes a detached craig session from the current terminal when available", async () => {
    const workspaceRoot = await createRepoRoot("craig-create-session-size-");
    const { paths, repoId, repoRoot } = await setupRegisteredRepo(workspaceRoot, "repo-a");
    const stubDir = await createStubCommands(workspaceRoot);
    const tmuxStateFile = `${workspaceRoot}/tmux-state`;
    const tmuxCommandLog = `${workspaceRoot}/tmux-commands.log`;

    Object.defineProperty(process.stdout, "columns", { value: 211, configurable: true });
    Object.defineProperty(process.stdout, "rows", { value: 61, configurable: true });

    process.env.PATH = `${stubDir}:${originalPath}`;
    process.env.CRAIG_TEST_TMUX_STATE_FILE = tmuxStateFile;
    process.env.CRAIG_TEST_TMUX_COMMAND_LOG = tmuxCommandLog;

    await createTask(paths, repoId, "session sizing");

    const tmuxCommands = await readFile(tmuxCommandLog, "utf8");
    const sessionName = getSessionNameForRepo(repoRoot);

    expect(tmuxCommands).toContain(
      `new-session -d -P -F #{window_id} #{pane_id} -s ${sessionName} -n ${sessionName} -x 211 -y 61 -c`,
    );
  });

  test("falls back to a new tmux window when the current window has no room for another pane", async () => {
    const workspaceRoot = await createRepoRoot("craig-create-window-fallback-");
    const { paths, repoId, repoRoot } = await setupRegisteredRepo(workspaceRoot, "repo-a");
    const stubDir = await createStubCommands(workspaceRoot);
    const tmuxStateFile = `${workspaceRoot}/tmux-state`;
    const tmuxCommandLog = `${workspaceRoot}/tmux-commands.log`;

    process.env.PATH = `${stubDir}:${originalPath}`;
    process.env.CRAIG_TEST_TMUX_STATE_FILE = tmuxStateFile;
    process.env.CRAIG_TEST_TMUX_COMMAND_LOG = tmuxCommandLog;
    process.env.CRAIG_TEST_TMUX_SPLIT_FAIL = "1";
    process.env.CRAIG_TEST_TMUX_NEW_WINDOW_PANE_ID = "%84";

    const result = await createTask(paths, repoId, "pane fallback");
    const task = await readTask(paths, result.taskId);
    const tmuxCommands = await readFile(tmuxCommandLog, "utf8");
    const sessionName = getSessionNameForRepo(repoRoot);

    expect(task.tmuxTarget).toBe("%84");
    expect(task.tmuxWindowTarget).toBe("@1");
    expect(task.tmuxPage).toBe(2);
    expect(tmuxCommands).toContain("split-window -d -P -F #{pane_id}");
    expect(tmuxCommands).toContain(`new-window -d -P -F #{window_id} #{pane_id} -t ${sessionName} -c`);
    expect(tmuxCommands).toContain("select-layout -t @1 tiled");
  });

  test("allocates the next task id when the first branch already exists", async () => {
    const workspaceRoot = await createRepoRoot("craig-create-collision-");
    const { paths, repoId } = await setupRegisteredRepo(workspaceRoot, "repo-a");
    const stubDir = await createStubCommands(workspaceRoot);
    const tmuxStateFile = `${workspaceRoot}/tmux-state`;
    const dateSegment = getDateSegment();

    process.env.PATH = `${stubDir}:${originalPath}`;
    process.env.CRAIG_TEST_TMUX_STATE_FILE = tmuxStateFile;
    process.env.CRAIG_TEST_GIT_EXISTING_BRANCHES = `refs/heads/craig/task_${dateSegment}_01`;

    const result = await createTask(paths, repoId, "branch collision");

    expect(result.taskId).toBe(`task_${dateSegment}_02`);
  });

  test("keeps a durable draft task when provisioning fails after allocation", async () => {
    const workspaceRoot = await createRepoRoot("craig-create-fail-");
    const { paths, repoId } = await setupRegisteredRepo(workspaceRoot, "repo-a");
    const stubDir = await createStubCommands(workspaceRoot);

    process.env.PATH = `${stubDir}:${originalPath}`;
    process.env.CRAIG_TEST_TMUX_FAIL = "1";

    await expect(createTask(paths, repoId, "tmux missing")).rejects.toThrow(/tmux/);

    const tasks = await import("../src/services/list-tasks.js").then(({ listTasks }) => listTasks(paths));
    expect(tasks.tasks).toHaveLength(1);
    const failedTask = tasks.tasks[0];

    expect(failedTask).toBeDefined();
    expect(failedTask?.status).toBe("draft");
    expect(failedTask?.runnerSession.lastKnownState).toBe("failed");
    expect(failedTask?.lastFailureReason).toMatch(/tmux/);
  });
});

async function setupRegisteredRepo(workspaceRoot: string, repoName: string) {
  tempRoots.push(workspaceRoot);
  const paths = await createCraigState(workspaceRoot);
  const repoRoot = path.join(workspaceRoot, repoName);
  await mkdir(repoRoot, { recursive: true });
  const repoId = `repo_${repoName}`;
  const workspaceId = `workspace_${repoId}`;
  const timestamp = "2026-04-24T00:00:00.000Z";

  await writeRepoRecord(
    workspaceRoot,
    {
      id: repoId,
      name: repoName,
      rootPath: repoRoot,
      defaultBranch: "main",
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    {
      id: workspaceId,
      primaryRepoId: repoId,
      branch: "main",
      status: "active",
      linkedRepoIds: [],
      archivedAt: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
  );

  return { paths, repoRoot, repoId, workspaceId };
}

function restoreStreamDimension(
  stream: typeof process.stdout,
  key: "columns" | "rows",
  descriptor: PropertyDescriptor | undefined,
): void {
  if (descriptor) {
    Object.defineProperty(stream, key, descriptor);
    return;
  }

  delete (stream as typeof process.stdout & Partial<Record<"columns" | "rows", number>>)[key];
}
