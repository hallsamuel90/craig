import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { createTask } from "../src/services/create-task.js";
import { getSessionNameForTask } from "../src/services/tmux-session.js";
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
  CRAIG_TEST_TMUX_STATE_FILE: process.env.CRAIG_TEST_TMUX_STATE_FILE,
  CRAIG_TEST_TMUX_COMMAND_LOG: process.env.CRAIG_TEST_TMUX_COMMAND_LOG,
  CRAIG_TEST_TMUX_WINDOW_TARGET: process.env.CRAIG_TEST_TMUX_WINDOW_TARGET,
  CRAIG_TEST_TMUX_SESSION_NAME: process.env.CRAIG_TEST_TMUX_SESSION_NAME,
};

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map(async (root) => rm(root, { recursive: true, force: true })));
  process.env.PATH = originalPath;
  restoreStreamDimension(process.stdout, "columns", originalStdoutColumns);
  restoreStreamDimension(process.stdout, "rows", originalStdoutRows);
  process.env.CRAIG_TEST_GIT_EXISTING_BRANCHES = originalEnv.CRAIG_TEST_GIT_EXISTING_BRANCHES;
  process.env.CRAIG_TEST_GIT_WORKTREE_FAIL = originalEnv.CRAIG_TEST_GIT_WORKTREE_FAIL;
  process.env.CRAIG_TEST_TMUX_FAIL = originalEnv.CRAIG_TEST_TMUX_FAIL;
  process.env.CRAIG_TEST_TMUX_STATE_FILE = originalEnv.CRAIG_TEST_TMUX_STATE_FILE;
  process.env.CRAIG_TEST_TMUX_COMMAND_LOG = originalEnv.CRAIG_TEST_TMUX_COMMAND_LOG;
  process.env.CRAIG_TEST_TMUX_WINDOW_TARGET = originalEnv.CRAIG_TEST_TMUX_WINDOW_TARGET;
  process.env.CRAIG_TEST_TMUX_SESSION_NAME = originalEnv.CRAIG_TEST_TMUX_SESSION_NAME;
});

describe("createTask", () => {
  test("creates a running task with a hidden per-task tmux session", async () => {
    const workspaceRoot = await createRepoRoot("craig-create-");
    const { paths, repoRoot, repoId, workspaceId } = await setupRegisteredRepo(workspaceRoot, "repo-a");
    const stubDir = await createStubCommands(workspaceRoot);
    const tmuxStateFile = `${workspaceRoot}/tmux-state`;
    const tmuxCommandLog = `${workspaceRoot}/tmux-commands.log`;
    const expectedSessionName = getSessionNameForTask(repoRoot, `task_${getDateSegment()}_01`);

    process.env.PATH = `${stubDir}:${originalPath}`;
    process.env.CRAIG_TEST_TMUX_STATE_FILE = tmuxStateFile;
    process.env.CRAIG_TEST_TMUX_COMMAND_LOG = tmuxCommandLog;
    process.env.CRAIG_TEST_TMUX_SESSION_NAME = expectedSessionName;

    const result = await createTask(paths, repoId, "refactor auth");
    const task = await readTask(paths, result.taskId);
    const session = await readSession(paths, result.sessionId);
    const tmuxCommands = await readFile(tmuxCommandLog, "utf8");

    expect(result.kind).toBe("createTask");
    expect(task.status).toBe("running");
    expect(task.repoId).toBe(repoId);
    expect(task.workspaceId).toBe(workspaceId);
    expect(task.sessionId).toBe(result.sessionId);
    expect(task.runnerSession.command).toEqual(["codex", "refactor auth"]);
    expect(task.runnerSession.lastKnownState).toBe("running");
    expect(task.worktreePath).toBe(path.join(paths.worktreesDir, repoId, result.taskId));
    expect(session.repoId).toBe(repoId);
    expect(session.taskId).toBe(result.taskId);
    expect(session.sessionName).toBe(expectedSessionName);
    expect(session.paneId).toBe("%42");
    expect(session.windowTarget).toBe("@0");
    expect(session.attach.detachChord).toBe("ctrl+]");
    expect(tmuxCommands).toContain(`new-session -d -P -F #{session_name} #{window_id} #{pane_id} -s ${expectedSessionName} -n runner -c`);
    expect(tmuxCommands).toContain(`set-option -t ${expectedSessionName} status off`);
    expect(tmuxCommands).toContain(`set-window-option -t ${expectedSessionName} pane-border-status off`);
    expect(tmuxCommands).toContain("send-keys -t %42");
    expect(tmuxCommands).toContain("'codex' 'refactor auth'");
  });

  test.each([
    ["cursor", "cursor-agent", "Cursor"],
    ["claude", "claude", "Claude"],
  ] as const)("creates a %s task with runner-specific command metadata", async (runner, executable, title) => {
    const workspaceRoot = await createRepoRoot(`craig-create-${runner}-`);
    const { paths, repoId } = await setupRegisteredRepo(workspaceRoot, "repo-a");
    const stubDir = await createStubCommands(workspaceRoot);
    const tmuxStateFile = `${workspaceRoot}/tmux-state`;
    const tmuxCommandLog = `${workspaceRoot}/tmux-commands.log`;

    process.env.PATH = `${stubDir}:${originalPath}`;
    process.env.CRAIG_TEST_TMUX_STATE_FILE = tmuxStateFile;
    process.env.CRAIG_TEST_TMUX_COMMAND_LOG = tmuxCommandLog;

    const result = await createTask(paths, repoId, `${runner} task`, { runner });
    const task = await readTask(paths, result.taskId);
    const tmuxCommands = await readFile(tmuxCommandLog, "utf8");

    expect(result.runner).toBe(runner);
    expect(task.runner).toBe(runner);
    expect(task.runnerSession.command).toEqual([executable, `${runner} task`]);
    expect(task.ptyTabs.find((tab) => tab.kind === "agent")).toMatchObject({
      title,
      command: [executable],
    });
    expect(tmuxCommands).toContain(`'${executable}' '${runner} task'`);
  });

  test("sizes a detached task session from the current terminal when available", async () => {
    const workspaceRoot = await createRepoRoot("craig-create-session-size-");
    const { paths, repoId, repoRoot } = await setupRegisteredRepo(workspaceRoot, "repo-a");
    const stubDir = await createStubCommands(workspaceRoot);
    const tmuxStateFile = `${workspaceRoot}/tmux-state`;
    const tmuxCommandLog = `${workspaceRoot}/tmux-commands.log`;
    const expectedSessionName = getSessionNameForTask(repoRoot, `task_${getDateSegment()}_01`);

    Object.defineProperty(process.stdout, "columns", { value: 211, configurable: true });
    Object.defineProperty(process.stdout, "rows", { value: 61, configurable: true });

    process.env.PATH = `${stubDir}:${originalPath}`;
    process.env.CRAIG_TEST_TMUX_STATE_FILE = tmuxStateFile;
    process.env.CRAIG_TEST_TMUX_COMMAND_LOG = tmuxCommandLog;
    process.env.CRAIG_TEST_TMUX_SESSION_NAME = expectedSessionName;

    await createTask(paths, repoId, "session sizing");

    const tmuxCommands = await readFile(tmuxCommandLog, "utf8");

    expect(tmuxCommands).toContain(
      `new-session -d -P -F #{session_name} #{window_id} #{pane_id} -s ${expectedSessionName} -n runner -x 211 -y 61 -c`,
    );
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

  test("keeps a durable draft task when session provisioning fails", async () => {
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
