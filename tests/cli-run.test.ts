import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { runCli, type RunCliOptions } from "../src/commands/run.js";
import { CRAIG_EXIT_CODE_BY_ERROR } from "../src/domain/error/index.js";
import { createCraigState, createGitRepo, createRepoRoot, writeTaskRecord } from "./test-helpers.js";
import { runCommand } from "../src/shared/exec.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("CLI execution contract", () => {
  test("writes one JSON success envelope to stdout and no stderr", async () => {
    const root = await createRepoRoot("craig-cli-json-");
    tempRoots.push(root);
    await createCraigState(root);
    const output = createOutput();

    const exitCode = await runCli(
      createOptions(root, ["context", "show", "--json"], output),
    );

    expect(exitCode).toBe(0);
    expect(output.stderr).toEqual([]);
    expect(output.stdout).toHaveLength(1);
    expect(JSON.parse(output.stdout[0]!)).toEqual({
      schemaVersion: 1,
      command: "context.show",
      ok: true,
      data: {
        kind: "showContext",
        workspace: {
          root,
          source: "ancestor",
          initialized: true,
        },
        task: null,
      },
      warnings: [],
    });
  });

  test("writes one JSON error envelope to stderr and no stdout", async () => {
    const root = await createRepoRoot("craig-cli-error-");
    tempRoots.push(root);
    const output = createOutput();

    const exitCode = await runCli(
      createOptions(root, ["--", "--json", "not-a-command"], output),
    );

    expect(exitCode).toBe(2);
    expect(output.stdout).toEqual([]);
    expect(output.stderr).toHaveLength(1);
    expect(JSON.parse(output.stderr[0]!)).toMatchObject({
      schemaVersion: 1,
      command: "cli",
      ok: false,
      error: {
        code: "CLI_USAGE",
        retryable: false,
        details: {},
      },
    });
  });

  test("resolves task identity from environment without UI selection", async () => {
    const root = await createRepoRoot("craig-cli-task-");
    const worktree = path.join(root, "worktree");
    tempRoots.push(root);
    await mkdir(worktree, { recursive: true });
    await createCraigState(root, ["task_1"]);
    const task = await writeTaskRecord(root, { id: "task_1", worktreePath: worktree });
    const agentTab = task.ptyTabs.find((tab) => tab.kind === "agent")!;
    const output = createOutput();

    const exitCode = await runCli({
      ...createOptions(root, ["--json", "task", "current"], output),
      env: {
        CRAIG_WORKSPACE_ROOT: root,
        CRAIG_TASK_ID: task.id,
        CRAIG_AGENT_TAB_ID: agentTab.id,
      },
    });

    expect(exitCode).toBe(0);
    expect(output.stderr).toEqual([]);
    expect(JSON.parse(output.stdout[0]!)).toMatchObject({
      command: "task.current",
      ok: true,
      data: {
        kind: "currentTask",
        task: { id: task.id },
        context: { source: "environment", agentTabId: agentTab.id },
      },
    });
  });

  test("executes task show without an id from cwd context", async () => {
    const root = await createRepoRoot("craig-cli-task-show-");
    const worktree = path.join(root, "worktree");
    tempRoots.push(root);
    await mkdir(worktree, { recursive: true });
    await createCraigState(root, ["task_1"]);
    await writeTaskRecord(root, { id: "task_1", worktreePath: worktree, sessionId: null });
    const output = createOutput();

    const exitCode = await runCli(
      createOptions(worktree, ["task", "show", "--json"], output),
    );

    expect(exitCode).toBe(0);
    expect(output.stderr).toEqual([]);
    expect(JSON.parse(output.stdout[0]!)).toMatchObject({
      command: "task.show",
      ok: true,
      data: {
        kind: "showTask",
        task: { id: "task_1" },
      },
    });
  });

  test("routes task PR commands through explicit global task context and JSON envelopes", async () => {
    const root = await createRepoRoot("craig-cli-task-pr-");
    tempRoots.push(root);
    await createGitRepo(root);
    await runCommand("git", ["remote", "add", "origin", "https://github.com/example/repo.git"], {
      cwd: root,
    });
    await createCraigState(root, ["task_1"]);
    await writeTaskRecord(root, {
      id: "task_1",
      worktreePath: root,
      branch: "craig/task_1",
      prs: [{
        provider: "github",
        owner: "example",
        repo: "repo",
        number: 17,
        url: "https://github.com/example/repo/pull/17",
        title: "PR 17",
        status: "open",
        draft: false,
        baseBranch: "main",
        headBranch: "craig/task_1",
        mergeable: false,
        mergeStateStatus: "BLOCKED",
        reviewDecision: null,
        requiredChecks: [],
        comments: [],
        createdAt: null,
        updatedAt: null,
        mergedAt: null,
        lastSyncedAt: null,
        lastSyncedHeadSha: null,
      }],
    });
    const output = createOutput();

    const exitCode = await runCli(
      createOptions(root, ["task", "pr", "show", "--task", "task_1", "--json"], output),
    );

    expect(exitCode).toBe(0);
    expect(output.stderr).toEqual([]);
    expect(JSON.parse(output.stdout[0]!)).toMatchObject({
      command: "task.pr.show",
      ok: true,
      data: {
        kind: "showTaskPr",
        taskId: "task_1",
        repoId: "repo_test",
        disposition: "shown",
        primaryPullRequest: { number: 17 },
      },
      warnings: [],
    });
  });

  test("does not enter the terminal application when input is disabled", async () => {
    const root = await createRepoRoot("craig-cli-no-input-");
    tempRoots.push(root);
    const output = createOutput();
    let interactiveCalls = 0;

    const exitCode = await runCli({
      ...createOptions(root, ["--no-input"], output),
      isInputTty: true,
      isOutputTty: true,
      runInteractive: async () => {
        interactiveCalls += 1;
        return 0;
      },
    });

    expect(exitCode).toBe(2);
    expect(interactiveCalls).toBe(0);
    expect(output.stdout).toEqual([]);
    expect(output.stderr[0]).toContain("requires a TTY");
  });

  test("rejects conflicting global and positional task targets", async () => {
    const root = await createRepoRoot("craig-cli-conflict-");
    tempRoots.push(root);
    await createCraigState(root);
    const output = createOutput();

    const exitCode = await runCli(
      createOptions(root, ["task", "logs", "task_1", "--task", "task_2", "--json"], output),
    );

    expect(exitCode).toBe(2);
    expect(output.stdout).toEqual([]);
    expect(JSON.parse(output.stderr[0]!)).toMatchObject({
      command: "task.logs",
      error: {
        code: "CLI_USAGE",
        details: { positionalTaskId: "task_1", globalTaskId: "task_2" },
      },
    });
  });

  test("does not let ambient agent context interfere with workspace-level commands", async () => {
    const root = await createRepoRoot("craig-cli-explicit-target-");
    tempRoots.push(root);
    await createCraigState(root);
    const output = createOutput();

    const exitCode = await runCli({
      ...createOptions(root, ["--json", "repo", "list"], output),
      env: {
        CRAIG_TASK_ID: "stale-task",
        CRAIG_AGENT_TAB_ID: "stale-agent-tab",
      },
    });

    expect(exitCode).toBe(0);
    expect(output.stderr).toEqual([]);
    expect(JSON.parse(output.stdout[0]!)).toMatchObject({
      command: "repo.list",
      ok: true,
      data: { kind: "listRepos" },
    });
  });

  test.each([
    {
      argv: ["task", "show", "task_missing", "--json"],
      command: "task.show",
      errorCode: "TASK_NOT_FOUND",
    },
    {
      argv: ["repo", "remove", "repo_missing", "--json"],
      command: "repo.remove",
      errorCode: "REPO_NOT_FOUND",
    },
    {
      argv: ["workspace", "archive", "workspace_missing", "--json"],
      command: "workspace.archive",
      errorCode: "WORKSPACE_NOT_FOUND",
    },
  ])("returns exit 3 for a missing $command target", async ({ argv, command, errorCode }) => {
    const root = await createRepoRoot("craig-cli-not-found-");
    tempRoots.push(root);
    await createCraigState(root);
    const output = createOutput();

    const exitCode = await runCli(createOptions(root, argv, output));

    expect(exitCode).toBe(3);
    expect(output.stdout).toEqual([]);
    expect(JSON.parse(output.stderr[0]!)).toMatchObject({
      command,
      ok: false,
      error: { code: errorCode, retryable: false },
    });
  });

  test("preserves corrupt task records as validation failures instead of not-found context", async () => {
    const root = await createRepoRoot("craig-cli-invalid-task-");
    tempRoots.push(root);
    const paths = await createCraigState(root, ["task_corrupt"]);
    await writeFile(path.join(paths.tasksDir, "task_corrupt.json"), "{bad json", "utf8");
    const output = createOutput();

    const exitCode = await runCli(
      createOptions(root, ["task", "current", "--task", "task_corrupt", "--json"], output),
    );

    expect(exitCode).toBe(2);
    expect(output.stdout).toEqual([]);
    expect(JSON.parse(output.stderr[0]!)).toMatchObject({
      command: "task.current",
      error: {
        code: "TASK_RECORD_INVALID",
        details: { taskId: "task_corrupt" },
      },
    });
  });

  test("defines one authoritative mapping for every stable exit category", () => {
    expect(CRAIG_EXIT_CODE_BY_ERROR).toMatchObject({
      CLI_USAGE: 2,
      WORKSPACE_CONTEXT_NOT_FOUND: 3,
      TASK_CONTEXT_CONFLICT: 4,
      PR_BRANCH_MISMATCH: 4,
      EXTERNAL_DEPENDENCY_FAILED: 5,
      OPERATION_TIMEOUT: 6,
      PARTIAL_RESULT: 7,
    });
  });
});

function createOutput(): { stdout: string[]; stderr: string[] } {
  return { stdout: [], stderr: [] };
}

function createOptions(
  cwd: string,
  argv: string[],
  output: { stdout: string[]; stderr: string[] },
): RunCliOptions {
  return {
    argv,
    cwd,
    env: {},
    isInputTty: false,
    isOutputTty: false,
    writeStdout: (value) => output.stdout.push(value.trimEnd()),
    writeStderr: (value) => output.stderr.push(value.trimEnd()),
    runInteractive: async () => 0,
  };
}
