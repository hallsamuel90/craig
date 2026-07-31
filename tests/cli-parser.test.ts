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
    [["task", "list"], "listTasks"],
    [["task", "show", "task_1"], "showTask"],
    [["task", "pr", "show", "task_1"], "showTaskPr"],
    [["task", "pr", "discover", "task_1"], "discoverTaskPr"],
    [["task", "pr", "link", "task_1", "--pr", "17"], "linkTaskPr"],
    [["task", "pr", "refresh", "task_1"], "refreshTaskPr"],
    [["task", "pr", "unlink", "task_1", "--pr", "17"], "unlinkTaskPr"],
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
