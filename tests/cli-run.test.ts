import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { runCli, type RunCliOptions } from "../src/commands/run.js";
import { CRAIG_EXIT_CODE_BY_ERROR } from "../src/domain/error/index.js";
import { createCraigState, createGitRepo, createRepoRoot, writeTaskRecord } from "./test-helpers.js";
import { runCommand } from "../src/shared/exec.js";
import { configService } from "../src/domain/config/index.js";

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

  test("reports agent status without requiring the activity preview or a live daemon", async () => {
    const root = await createRepoRoot("craig-cli-agent-status-");
    tempRoots.push(root);
    await createCraigState(root, ["task_1"]);
    const task = await writeTaskRecord(root, { id: "task_1" });
    const agentTab = task.ptyTabs.find((tab) => tab.kind === "agent")!;
    const output = createOutput();

    const exitCode = await runCli(createOptions(root, [
      "agent", "status", "--task", task.id, "--tab", agentTab.id, "--json",
    ], output));

    expect(exitCode).toBe(0);
    expect(output.stderr).toEqual([]);
    expect(JSON.parse(output.stdout[0]!)).toMatchObject({
      command: "agent.status",
      ok: true,
      data: {
        kind: "showAgentStatus",
        daemonAvailable: false,
        agents: [{ taskId: task.id, tabId: agentTab.id, state: "idle" }],
        tasks: [{ taskId: task.id, state: "idle" }],
      },
    });
  });

  test("lists every agent when invoked from a task worktree without an explicit filter", async () => {
    const root = await createRepoRoot("craig-cli-agent-list-");
    const firstWorktree = path.join(root, "task-1");
    tempRoots.push(root);
    await mkdir(firstWorktree, { recursive: true });
    await createCraigState(root, ["task_1", "task_2"]);
    await writeTaskRecord(root, { id: "task_1", worktreePath: firstWorktree });
    await writeTaskRecord(root, { id: "task_2" });
    const output = createOutput();

    const exitCode = await runCli(createOptions(firstWorktree, ["agent", "list", "--json"], output));

    expect(exitCode).toBe(0);
    const result = JSON.parse(output.stdout[0]!) as { data: { agents: Array<{ taskId: string }> } };
    expect(result.data.agents.map((agent) => agent.taskId)).toEqual(["task_1", "task_2"]);
  });

  test("returns machine-readable task wait success and timeout results", async () => {
    const root = await createRepoRoot("craig-cli-agent-wait-");
    tempRoots.push(root);
    await createCraigState(root, ["task_1"]);
    await writeTaskRecord(root, { id: "task_1" });
    const successOutput = createOutput();
    const timeoutOutput = createOutput();

    const success = await runCli(createOptions(root, [
      "task", "wait", "task_1", "--state", "idle", "--timeout", "0ms", "--json",
    ], successOutput));
    const timeout = await runCli(createOptions(root, [
      "task", "wait", "task_1", "--state", "ready", "--timeout", "0ms", "--json",
    ], timeoutOutput));

    expect(success).toBe(0);
    expect(JSON.parse(successOutput.stdout[0]!)).toMatchObject({
      command: "task.wait",
      data: { kind: "waitTask", taskId: "task_1", state: "idle" },
    });
    expect(timeout).toBe(6);
    expect(JSON.parse(timeoutOutput.stderr[0]!)).toMatchObject({
      command: "task.wait",
      error: { code: "OPERATION_TIMEOUT", retryable: true },
    });
  });

  test("returns a distinct machine-readable cancellation for task wait", async () => {
    const root = await createRepoRoot("craig-cli-agent-cancel-");
    tempRoots.push(root);
    await createCraigState(root, ["task_1"]);
    await writeTaskRecord(root, { id: "task_1" });
    const output = createOutput();
    const controller = new AbortController();
    controller.abort();

    const exitCode = await runCli({
      ...createOptions(root, [
        "task", "wait", "task_1", "--state", "ready", "--timeout", "1m", "--json",
      ], output),
      signal: controller.signal,
    });

    expect(exitCode).toBe(6);
    expect(JSON.parse(output.stderr[0]!)).toMatchObject({
      command: "task.wait",
      error: { code: "OPERATION_CANCELLED", retryable: true, details: { cancelled: true } },
    });
  });

  test("gates event commands behind agentOrchestration and lists reconciled events when enabled", async () => {
    const root = await createRepoRoot("craig-cli-events-");
    tempRoots.push(root);
    const paths = await createCraigState(root, ["task_1"]);
    await writeTaskRecord(root, { id: "task_1" });
    const disabled = createOutput();
    const enabled = createOutput();

    expect(await runCli(createOptions(root, ["events", "list", "--json"], disabled))).toBe(2);
    expect(JSON.parse(disabled.stderr[0]!)).toMatchObject({
      command: "events.list",
      error: { code: "CLI_USAGE", details: { preview: "agentOrchestration" } },
    });

    await configService.save(paths, { previews: { agentOrchestration: true } });
    expect(await runCli(createOptions(root, ["events", "list", "--task", "task_1", "--json"], enabled))).toBe(0);
    expect(JSON.parse(enabled.stdout[0]!)).toMatchObject({
      command: "events.list",
      data: {
        kind: "listEvents",
        events: [
          { sequence: 1, type: "task.created", taskId: "task_1" },
          { sequence: 2, type: "agent.state.changed", taskId: "task_1" },
        ],
        cursor: { sequence: 2 },
      },
    });
  });

  test("streams resumable JSONL events and uses the journal-backed task wait while previewed", async () => {
    const root = await createRepoRoot("craig-cli-events-watch-");
    tempRoots.push(root);
    const paths = await createCraigState(root, ["task_1"]);
    await writeTaskRecord(root, { id: "task_1" });
    await configService.save(paths, { previews: { agentOrchestration: true } });
    const output = createOutput();
    const controller = new AbortController();
    const watchOptions = createOptions(root, ["events", "watch", "--format", "jsonl"], output);
    watchOptions.signal = controller.signal;
    watchOptions.writeStdout = (value) => {
      output.stdout.push(value.trimEnd());
      controller.abort();
    };

    expect(await runCli(watchOptions)).toBe(0);
    expect(output.stdout.length).toBeGreaterThan(0);
    expect(JSON.parse(output.stdout[0]!)).toMatchObject({ schemaVersion: 1, type: "task.created" });

    const waitOutput = createOutput();
    expect(await runCli(createOptions(root, [
      "task", "wait", "task_1", "--state", "idle", "--timeout", "0ms", "--json",
    ], waitOutput))).toBe(0);
    expect(JSON.parse(waitOutput.stdout[0]!)).toMatchObject({
      command: "task.wait",
      data: { state: "idle" },
    });
  });

  test("gates prompt creation while keeping durable command inspection and cancellation available", async () => {
    const root = await createRepoRoot("craig-cli-prompt-");
    tempRoots.push(root);
    const paths = await createCraigState(root, ["task_1"]);
    const task = await writeTaskRecord(root, { id: "task_1" });
    const output = createOutput();

    expect(await runCli(createOptions(root, [
      "agent", "send", "--task", task.id, "--prompt", "continue", "--json",
    ], output))).toBe(2);
    expect(JSON.parse(output.stderr.pop()!)).toMatchObject({
      command: "agent.send",
      error: { code: "CLI_USAGE", details: { preview: "agentOrchestration" } },
    });

    await configService.save(paths, { previews: { agentOrchestration: true } });
    const sendOutput = createOutput();
    const sendOptions = createOptions(root, [
      "agent", "send", "--task", task.id, "--stdin", "--idempotency-key", "cli-send-1", "--json",
    ], sendOutput);
    sendOptions.readStdin = async () => "continue from stdin";
    expect(await runCli(sendOptions)).toBe(0);
    const sent = JSON.parse(sendOutput.stdout[0]!).data;
    expect(sent).toMatchObject({
      kind: "sendAgentPrompt",
      created: true,
      command: {
        taskId: task.id,
        prompt: { source: "stdin", text: "continue from stdin" },
        state: "queued",
      },
    });

    const commandId = sent.command.id as string;
    const listOutput = createOutput();
    expect(await runCli(createOptions(root, ["command", "list", "--task", task.id, "--json"], listOutput))).toBe(0);
    expect(JSON.parse(listOutput.stdout[0]!).data.commands).toHaveLength(1);

    const waitOutput = createOutput();
    expect(await runCli(createOptions(root, [
      "command", "wait", commandId, "--state", "queued", "--timeout", "1s", "--json",
    ], waitOutput))).toBe(0);
    expect(JSON.parse(waitOutput.stdout[0]!).data.command.state).toBe("queued");

    await configService.save(paths, { previews: { agentOrchestration: false } });
    const cancelOutput = createOutput();
    expect(await runCli(createOptions(root, ["command", "cancel", commandId, "--json"], cancelOutput))).toBe(0);
    expect(JSON.parse(cancelOutput.stdout[0]!).data).toMatchObject({
      kind: "cancelPromptCommand",
      changed: true,
      command: { state: "cancelled" },
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
      OPERATION_CANCELLED: 6,
      EVENT_CURSOR_INVALID: 2,
      EVENT_CURSOR_EXPIRED: 4,
      EVENT_JOURNAL_CORRUPT: 2,
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
