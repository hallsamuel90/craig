import { readFile, rm } from "node:fs/promises";

import { afterEach, describe, expect, test } from "vitest";

import {
  createDetachedTaskSession,
  focusPane,
  getSessionNameForRepo,
  getSessionNameForTask,
  resizeSessionWindow,
} from "../src/domain/task/adapters/tmux.js";
import { createRepoRoot, createStubCommands } from "./test-helpers.js";

const tempRoots: string[] = [];
const originalPath = process.env.PATH ?? "";
const originalEnv = {
  CRAIG_TEST_TMUX_COMMAND_LOG: process.env.CRAIG_TEST_TMUX_COMMAND_LOG,
  CRAIG_TEST_TMUX_SESSION_NAME: process.env.CRAIG_TEST_TMUX_SESSION_NAME,
  TMUX: process.env.TMUX,
};

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map(async (root) => rm(root, { recursive: true, force: true })));
  process.env.PATH = originalPath;
  process.env.CRAIG_TEST_TMUX_COMMAND_LOG = originalEnv.CRAIG_TEST_TMUX_COMMAND_LOG;
  process.env.CRAIG_TEST_TMUX_SESSION_NAME = originalEnv.CRAIG_TEST_TMUX_SESSION_NAME;
  process.env.TMUX = originalEnv.TMUX;
});

describe("createDetachedTaskSession", () => {
  test("creates a dedicated tmux session per task", async () => {
    const repoRoot = await createRepoRoot("craig-session-");
    tempRoots.push(repoRoot);
    const stubDir = await createStubCommands(repoRoot);
    const tmuxCommandLog = `${repoRoot}/tmux-commands.log`;
    const expectedSessionName = getSessionNameForTask(repoRoot, "task_1");

    process.env.PATH = `${stubDir}:${originalPath}`;
    process.env.CRAIG_TEST_TMUX_COMMAND_LOG = tmuxCommandLog;
    process.env.CRAIG_TEST_TMUX_SESSION_NAME = expectedSessionName;

    const session = await createDetachedTaskSession(repoRoot, "task_1", `${repoRoot}/worktree`);
    const tmuxCommands = await readFile(tmuxCommandLog, "utf8");

    expect(session.sessionName).toBe(expectedSessionName);
    expect(session.paneId).toBe("%42");
    expect(tmuxCommands).toContain(`new-session -d -P -F #{session_name} #{window_id} #{pane_id} -s ${expectedSessionName} -n runner -c`);
    expect(tmuxCommands).toContain(`set-option -t ${expectedSessionName} status off`);
  });
});

describe("focusPane", () => {
  test("attaches the task session when launched outside tmux", async () => {
    const repoRoot = await createRepoRoot("craig-focus-");
    tempRoots.push(repoRoot);
    const stubDir = await createStubCommands(repoRoot);
    const tmuxCommandLog = `${repoRoot}/tmux-commands.log`;
    const sessionName = getSessionNameForTask(repoRoot, "task_1");

    process.env.PATH = `${stubDir}:${originalPath}`;
    process.env.CRAIG_TEST_TMUX_COMMAND_LOG = tmuxCommandLog;
    process.env.CRAIG_TEST_TMUX_SESSION_NAME = sessionName;
    delete process.env.TMUX;

    await focusPane(repoRoot, "%42", "@0", sessionName);

    const tmuxCommands = await readFile(tmuxCommandLog, "utf8");

    expect(tmuxCommands).toContain("select-window -t @0");
    expect(tmuxCommands).toContain("select-pane -t %42");
    expect(tmuxCommands).toContain(`attach-session -t ${sessionName}`);
  });

  test("switches the current client when already inside tmux", async () => {
    const repoRoot = await createRepoRoot("craig-focus-client-");
    tempRoots.push(repoRoot);
    const stubDir = await createStubCommands(repoRoot);
    const tmuxCommandLog = `${repoRoot}/tmux-commands.log`;
    const sessionName = getSessionNameForTask(repoRoot, "task_1");

    process.env.PATH = `${stubDir}:${originalPath}`;
    process.env.CRAIG_TEST_TMUX_COMMAND_LOG = tmuxCommandLog;
    process.env.CRAIG_TEST_TMUX_SESSION_NAME = sessionName;
    process.env.TMUX = "stub-client";

    await focusPane(repoRoot, "%42", "@0", sessionName);

    const tmuxCommands = await readFile(tmuxCommandLog, "utf8");

    expect(tmuxCommands).toContain(`switch-client -t ${sessionName}`);
    expect(tmuxCommands).not.toContain(`attach-session -t ${sessionName}`);
  });
});

describe("resizeSessionWindow", () => {
  test("resizes a hidden task session window", async () => {
    const repoRoot = await createRepoRoot("craig-resize-session-");
    tempRoots.push(repoRoot);
    const stubDir = await createStubCommands(repoRoot);
    const tmuxCommandLog = `${repoRoot}/tmux-commands.log`;
    const sessionName = getSessionNameForRepo(repoRoot);

    process.env.PATH = `${stubDir}:${originalPath}`;
    process.env.CRAIG_TEST_TMUX_COMMAND_LOG = tmuxCommandLog;

    await resizeSessionWindow(repoRoot, sessionName, { columns: 180, rows: 52 });

    const tmuxCommands = await readFile(tmuxCommandLog, "utf8");

    expect(tmuxCommands).toContain(`resize-window -t ${sessionName} -x 180 -y 52`);
  });
});
