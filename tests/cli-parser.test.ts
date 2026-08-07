import { describe, expect, test } from "vitest";

import { CraigError } from "../src/domain/error/index.js";
import { hasJsonOutputFlag, parseArgv } from "../src/commands/parse-argv.js";

describe("CLI argument parsing", () => {
  test.each([
    [["repo", "add", "."], "addRepo"],
    [["repo", "list"], "listRepos"],
    [["repo", "remove", "repo_1"], "removeRepo"],
    [["workspace", "add", "."], "addWorkspace"],
    [["workspace", "list"], "listWorkspaces"],
    [["workspace", "list", "--archived"], "listWorkspaces"],
    [["workspace", "archive", "workspace_1"], "archiveWorkspace"],
    [["workspace", "restore", "workspace_1"], "restoreWorkspace"],
    [["workspace", "remove", "workspace_1"], "removeWorkspace"],
    [["task", "new", "--repo", "repo_1", "ship it"], "createTask"],
    [["task", "create-child", "--parent", "task_1", "--repo", "repo_1", "ship it"], "createChildTask"],
    [["task", "children", "task_1"], "listTaskChildren"],
    [["task", "cancel-tree", "task_1"], "cancelTaskTree"],
    [["task", "list"], "listTasks"],
    [["task", "show", "task_1"], "showTask"],
    [["task", "pr", "show", "task_1"], "showTaskPr"],
    [["task", "pr", "discover", "task_1"], "discoverTaskPr"],
    [["task", "pr", "link", "task_1", "--pr", "17"], "linkTaskPr"],
    [["task", "pr", "refresh", "task_1"], "refreshTaskPr"],
    [["task", "pr", "unlink", "task_1", "--pr", "17"], "unlinkTaskPr"],
    [["agent", "list"], "listAgents"],
    [["agent", "status", "--tab", "task_1:agent"], "showAgentStatus"],
    [["agent", "send", "--prompt", "continue"], "sendAgentPrompt"],
    [["command", "show", "command_1"], "showPromptCommand"],
    [["command", "list"], "listPromptCommands"],
    [["command", "cancel", "command_1"], "cancelPromptCommand"],
    [["command", "wait", "command_1"], "waitPromptCommand"],
    [["task", "wait", "task_1", "--state", "ready,error"], "waitTask"],
    [["events", "list", "--type", "agent.*"], "listEvents"],
    [["events", "watch", "--format", "jsonl"], "watchEvents"],
    [["task", "attach", "task_1"], "attachTask"],
    [["task", "logs", "task_1"], "streamTaskLogs"],
    [["task", "diff", "task_1"], "showTaskDiff"],
    [["task", "focus", "task_1"], "focusTask"],
    [["task", "open", "task_1"], "openTask"],
    [["task", "check", "task_1"], "runChecks"],
    [["task", "commit", "task_1"], "commitTask"],
    [["link", "add", "task_1", "repo_1"], "addTaskLink"],
    [["link", "list", "task_1"], "listTaskLinks"],
  ] as const)("preserves existing %s parsing with global options in either order", (argv, expectedKind) => {
    expect(parseArgv([...argv]).command?.kind).toBe(expectedKind);
    expect(parseArgv(["--json", ...argv])).toMatchObject({
      command: { kind: expectedKind },
      options: { json: true },
    });
    expect(parseArgv([...argv, "--json"])).toMatchObject({
      command: { kind: expectedKind },
      options: { json: true },
    });
  });

  test("accepts global options before, between, and after command tokens", () => {
    const parsed = parseArgv([
      "--json",
      "task",
      "--workspace-root",
      "./workspace",
      "current",
      "--task",
      "task_1",
      "--no-input",
    ]);

    expect(parsed.command).toEqual({ kind: "currentTask" });
    expect(parsed.options).toEqual({
      json: true,
      noInput: true,
      workspaceRoot: "./workspace",
      taskId: "task_1",
    });
  });

  test("supports context commands and optional task show context", () => {
    expect(parseArgv(["context", "show"]).command).toEqual({ kind: "showContext" });
    expect(parseArgv(["task", "current"]).command).toEqual({ kind: "currentTask" });
    expect(parseArgv(["task", "show"]).command).toEqual({ kind: "showCurrentTask" });
    expect(parseArgv(["task", "show", "task_1"]).command).toEqual({
      kind: "showTask",
      taskId: "task_1",
    });
  });

  test("parses child delegation options and context-defaulted tree commands", () => {
    expect(parseArgv([
      "task", "create-child", "--repo", "repo_a", "--parent", "task_1",
      "--runner", "claude", "--idempotency-key", "phase-a", "implement", "phase", "a",
    ]).command).toEqual({
      kind: "createChildTask",
      parentTaskId: "task_1",
      repoId: "repo_a",
      runner: "claude",
      idempotencyKey: "phase-a",
      prompt: "implement phase a",
    });
    expect(parseArgv(["task", "children"]).command).toEqual({ kind: "listTaskChildren" });
    expect(parseArgv(["task", "cancel-tree"]).command).toEqual({ kind: "cancelTaskTree" });
  });

  test("parses PR repair commands with optional task and repo targets", () => {
    expect(parseArgv(["task", "pr", "show", "--repo", "repo_a"]).command).toEqual({
      kind: "showTaskPr",
      repoId: "repo_a",
    });
    expect(
      parseArgv([
        "task",
        "pr",
        "link",
        "--pr",
        "https://github.com/example/repo/pull/17",
        "task_1",
        "--repo",
        "repo_a",
      ]).command,
    ).toEqual({
      kind: "linkTaskPr",
      taskId: "task_1",
      repoId: "repo_a",
      pullRequest: "https://github.com/example/repo/pull/17",
    });
  });

  test("parses agent status and wait commands", () => {
    expect(parseArgv(["agent", "list", "--task", "task_1"]).command).toEqual({
      kind: "listAgents",
    });
    expect(parseArgv(["agent", "status", "--task", "task_1", "--tab", "task_1:agent"]).command).toEqual({
      kind: "showAgentStatus",
      tabId: "task_1:agent",
    });
    expect(parseArgv([
      "task", "wait", "task_1", "--state", "ready,error,ready", "--tab", "task_1:agent", "--timeout", "30s",
    ]).command).toEqual({
      kind: "waitTask",
      taskId: "task_1",
      states: ["ready", "error"],
      tabId: "task_1:agent",
      timeoutMs: 30_000,
    });
  });

  test("rejects invalid agent status and wait options", () => {
    for (const argv of [
      ["agent", "list", "extra"],
      ["agent", "status", "--tab"],
      ["task", "wait", "task_1"],
      ["task", "wait", "task_1", "--state", "done"],
      ["task", "wait", "task_1", "--state", "ready", "--timeout", "30"],
      ["task", "wait", "task_1", "--state", "ready", "--state", "error"],
    ]) {
      expect(() => parseArgv(argv)).toThrow();
    }
  });

  test("parses prompt dispatch and durable command operations", () => {
    expect(parseArgv([
      "agent", "send", "--task", "task_1", "--tab", "task_1:agent", "--prompt", "continue",
      "--delivery", "immediate", "--timeout", "30s", "--idempotency-key", "dispatch-1",
    ]).command).toEqual({
      kind: "sendAgentPrompt",
      tabId: "task_1:agent",
      prompt: { source: "inline", text: "continue" },
      delivery: "immediate",
      timeoutMs: 30_000,
      idempotencyKey: "dispatch-1",
    });
    expect(parseArgv(["agent", "send", "--prompt-file", "prompt.md"]).command).toMatchObject({
      prompt: { source: "file", path: "prompt.md" },
      delivery: "when-ready",
    });
    expect(parseArgv(["agent", "send", "--stdin"]).command).toMatchObject({ prompt: { source: "stdin" } });
    expect(parseArgv([
      "command", "wait", "command_1", "--state", "delivered,failed,delivered", "--timeout", "2m",
    ]).command).toEqual({
      kind: "waitPromptCommand",
      commandId: "command_1",
      states: ["delivered", "failed"],
      timeoutMs: 120_000,
    });
  });

  test("rejects invalid prompt and command options", () => {
    for (const argv of [
      ["agent", "send"],
      ["agent", "send", "--prompt", "one", "--stdin"],
      ["agent", "send", "--prompt", "one", "--delivery", "later"],
      ["agent", "send", "--prompt-file"],
      ["command", "list", "extra"],
      ["command", "wait", "command_1", "--state", "unknown"],
      ["command", "wait", "command_1", "--timeout", "30"],
    ]) {
      expect(() => parseArgv(argv)).toThrow();
    }
  });

  test("parses event filters and rejects invalid stream options", () => {
    expect(parseArgv(["events", "list", "--task", "task_1", "--type", "task.*", "--after", "12"]).command)
      .toEqual({ kind: "listEvents", typeGlob: "task.*", after: "12" });
    expect(parseArgv(["events", "watch", "--format", "jsonl", "--after", "event-id"]).command)
      .toEqual({ kind: "watchEvents", format: "jsonl", after: "event-id" });
    for (const argv of [
      ["events", "list", "--format", "jsonl"],
      ["events", "watch", "--format", "xml"],
      ["events", "watch", "--type"],
      ["events", "list", "--after", "1", "--after", "2"],
    ]) {
      expect(() => parseArgv(argv)).toThrow();
    }
  });

  test("rejects missing, duplicate, and inapplicable PR repair options", () => {
    for (const argv of [
      ["task", "pr", "link", "task_1"],
      ["task", "pr", "unlink", "task_1", "--pr", "17", "--pr", "18"],
      ["task", "pr", "show", "task_1", "--pr", "17"],
      ["task", "pr", "refresh", "task_1", "--repo"],
    ]) {
      expect(() => parseArgv(argv)).toThrow();
    }
  });

  test("preserves command-level option termination for prompt content", () => {
    expect(
      parseArgv(["task", "new", "--repo", "repo_1", "--", "--json", "is prompt text"]).command,
    ).toEqual({
      kind: "createTask",
      repoId: "repo_1",
      prompt: "--json is prompt text",
    });
  });

  test("retains the package-manager leading separator compatibility", () => {
    expect(parseArgv(["--", "--json", "repo", "list"]).options.json).toBe(true);
    expect(hasJsonOutputFlag(["--", "--json", "not-a-command"])).toBe(true);
  });

  test("reports duplicate and missing global values as stable usage failures", () => {
    for (const argv of [
      ["--json", "repo", "list", "--json"],
      ["repo", "list", "--workspace-root"],
    ]) {
      try {
        parseArgv(argv);
        throw new Error("Expected parsing to fail.");
      } catch (error) {
        expect(error).toBeInstanceOf(CraigError);
        expect(error).toMatchObject({ code: "CLI_USAGE", exitCode: 2 });
      }
    }
  });
});
