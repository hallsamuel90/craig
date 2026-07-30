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
