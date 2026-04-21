import { rm } from "node:fs/promises";
import { afterEach, describe, expect, test } from "vitest";

import { executeCommand } from "../src/commands/command-router.js";
import { parseArgv } from "../src/commands/parse-argv.js";
import { parseReplCommand } from "../src/commands/parse-repl.js";
import { readTask } from "../src/state/task-store.js";
import { createCraigState, createRepoRoot, createStubCommands } from "./test-helpers.js";

const tempRoots: string[] = [];
const originalPath = process.env.PATH ?? "";
const originalEnv = {
  CRAIG_TEST_GIT_EXISTING_BRANCHES: process.env.CRAIG_TEST_GIT_EXISTING_BRANCHES,
  CRAIG_TEST_GIT_WORKTREE_FAIL: process.env.CRAIG_TEST_GIT_WORKTREE_FAIL,
  CRAIG_TEST_TMUX_STATE_FILE: process.env.CRAIG_TEST_TMUX_STATE_FILE,
  CRAIG_TEST_TMUX_COMMAND_LOG: process.env.CRAIG_TEST_TMUX_COMMAND_LOG,
};

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map(async (root) => rm(root, { recursive: true, force: true })),
  );
  process.env.PATH = originalPath;
  process.env.CRAIG_TEST_GIT_EXISTING_BRANCHES = originalEnv.CRAIG_TEST_GIT_EXISTING_BRANCHES;
  process.env.CRAIG_TEST_GIT_WORKTREE_FAIL = originalEnv.CRAIG_TEST_GIT_WORKTREE_FAIL;
  process.env.CRAIG_TEST_TMUX_STATE_FILE = originalEnv.CRAIG_TEST_TMUX_STATE_FILE;
  process.env.CRAIG_TEST_TMUX_COMMAND_LOG = originalEnv.CRAIG_TEST_TMUX_COMMAND_LOG;
});

describe("command routing", () => {
  test("argv and REPL list commands normalize to the same command", () => {
    expect(parseArgv(["task", "list"]).command).toEqual({ kind: "listTasks" });
    expect(parseArgv(["--", "task", "list"]).command).toEqual({ kind: "listTasks" });
    expect(parseReplCommand("list")).toEqual({ kind: "listTasks" });
  });

  test("argv and REPL new commands normalize to the same command", () => {
    expect(parseArgv(["task", "new", "refactor", "auth"]).command).toEqual({
      kind: "createTask",
      title: "refactor auth",
    });
    expect(parseReplCommand("new refactor auth")).toEqual({
      kind: "createTask",
      title: "refactor auth",
    });
  });

  test("shared executor handles list commands from both entry points", async () => {
    const repoRoot = await createRepoRoot("craig-router-");
    tempRoots.push(repoRoot);
    const paths = await createCraigState(repoRoot);

    const argvCommand = parseArgv(["task", "list"]).command;
    const replCommand = parseReplCommand("list");

    const argvResult = await executeCommand(argvCommand!, { paths });
    const replResult = await executeCommand(replCommand, { paths });

    expect(argvResult).toEqual(replResult);
  });

  test("shared executor handles create-task commands from both entry points", async () => {
    const repoRootA = await createRepoRoot("craig-router-create-a-");
    const repoRootB = await createRepoRoot("craig-router-create-b-");
    tempRoots.push(repoRootA, repoRootB);
    const pathsA = await createCraigState(repoRootA);
    const pathsB = await createCraigState(repoRootB);
    const stubDir = await createStubCommands(repoRootA);
    const tmuxStateFile = `${repoRootA}/tmux-state`;
    const tmuxCommandLog = `${repoRootA}/tmux-commands.log`;

    process.env.PATH = `${stubDir}:${originalPath}`;
    process.env.CRAIG_TEST_TMUX_STATE_FILE = tmuxStateFile;
    process.env.CRAIG_TEST_TMUX_COMMAND_LOG = tmuxCommandLog;

    const argvResult = await executeCommand(parseArgv(["task", "new", "refactor", "auth"]).command!, {
      paths: pathsA,
    });
    const replResult = await executeCommand(parseReplCommand("new refactor auth"), {
      paths: pathsB,
    });

    if (argvResult.kind !== "createTask" || replResult.kind !== "createTask") {
      throw new Error("Expected createTask results from both command paths.");
    }

    expect(argvResult.kind).toBe("createTask");
    expect(replResult.kind).toBe("createTask");
    expect(argvResult.branch).toBe(replResult.branch);
    expect(argvResult.runner).toBe("cursor");
    expect(replResult.runner).toBe("cursor");

    const createdTask = await readTask(pathsA, argvResult.taskId);
    expect(createdTask.status).toBe("running");
  });

  test("unknown commands are rejected in both parsing flows", () => {
    expect(() => parseArgv(["task", "unknown"])).toThrow(/Unsupported command/);
    expect(() => parseReplCommand("wat")).toThrow(/Unknown command/);
  });
  test("empty new commands are rejected", () => {
    expect(() => parseArgv(["task", "new"])).toThrow(/Task title cannot be empty/);
    expect(() => parseReplCommand("new")).toThrow(/Task title cannot be empty/);
  });
});
