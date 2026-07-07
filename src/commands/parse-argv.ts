import type { AppCommand } from "./types.js";
import { configService } from "../domain/config/index.js";

export interface ParsedArgvCommand {
  mode: "interactive" | "command";
  command?: AppCommand;
}

export function parseArgv(argv: string[]): ParsedArgvCommand {
  const trimmedArgv = [...argv];

  while (trimmedArgv[0] === "--") {
    trimmedArgv.shift();
  }

  if (trimmedArgv.length === 0) {
    return { mode: "interactive" };
  }

  if (trimmedArgv.length >= 3 && trimmedArgv[0] === "repo" && trimmedArgv[1] === "add") {
    const repoPath = trimmedArgv.slice(2).join(" ").trim();

    if (repoPath.length === 0) {
      throw new Error("Repo path cannot be empty.\n\n" + getHelpText());
    }

    return { mode: "command", command: { kind: "addRepo", path: repoPath } };
  }

  if (trimmedArgv.length >= 3 && trimmedArgv[0] === "workspace" && trimmedArgv[1] === "add") {
    const workspacePath = trimmedArgv.slice(2).join(" ").trim();

    if (workspacePath.length === 0) {
      throw new Error("Workspace path cannot be empty.\n\n" + getHelpText());
    }

    return { mode: "command", command: { kind: "addWorkspace", path: workspacePath } };
  }

  if (trimmedArgv.length === 2 && trimmedArgv[0] === "repo" && trimmedArgv[1] === "list") {
    return { mode: "command", command: { kind: "listRepos" } };
  }

  if (trimmedArgv.length === 3 && trimmedArgv[0] === "repo" && trimmedArgv[1] === "remove") {
    return { mode: "command", command: { kind: "removeRepo", repoId: trimmedArgv[2]!.trim() } };
  }

  if (
    trimmedArgv.length >= 2 &&
    trimmedArgv.length <= 3 &&
    trimmedArgv[0] === "workspace" &&
    trimmedArgv[1] === "list"
  ) {
    const archived = trimmedArgv[2] === "--archived";

    if (trimmedArgv.length === 3 && !archived) {
      throw new Error(`Unsupported command: ${trimmedArgv.join(" ")}\n\n${getHelpText()}`);
    }

    return { mode: "command", command: { kind: "listWorkspaces", archived } };
  }

  if (trimmedArgv.length === 3 && trimmedArgv[0] === "workspace" && trimmedArgv[1] === "archive") {
    return { mode: "command", command: { kind: "archiveWorkspace", workspaceId: trimmedArgv[2]!.trim() } };
  }

  if (trimmedArgv.length === 3 && trimmedArgv[0] === "workspace" && trimmedArgv[1] === "restore") {
    return { mode: "command", command: { kind: "restoreWorkspace", workspaceId: trimmedArgv[2]!.trim() } };
  }

  if (trimmedArgv.length === 3 && trimmedArgv[0] === "workspace" && trimmedArgv[1] === "remove") {
    return { mode: "command", command: { kind: "removeWorkspace", workspaceId: trimmedArgv[2]!.trim() } };
  }

  if (trimmedArgv.length >= 2 && trimmedArgv[0] === "task" && trimmedArgv[1] === "new") {
    const repoFlagIndex = trimmedArgv.indexOf("--repo");
    const workspaceFlagIndex = trimmedArgv.indexOf("--workspace");
    const runnerFlagIndex = trimmedArgv.indexOf("--runner");

    if (repoFlagIndex === -1 && workspaceFlagIndex === -1) {
      throw new Error("Task creation now requires '--repo <repo-id>' or '--workspace <workspace-id>'.\n\n" + getHelpText());
    }

    if (repoFlagIndex !== -1 && workspaceFlagIndex !== -1) {
      throw new Error("Task creation accepts either '--repo' or '--workspace', not both.\n\n" + getHelpText());
    }

    const repoId = repoFlagIndex === -1 ? undefined : trimmedArgv[repoFlagIndex + 1]?.trim() ?? "";
    const workspaceId = workspaceFlagIndex === -1 ? undefined : trimmedArgv[workspaceFlagIndex + 1]?.trim() ?? "";
    const runner = runnerFlagIndex === -1
      ? undefined
      : configService.runners.parse(trimmedArgv[runnerFlagIndex + 1]?.trim() ?? "");
    const promptParts = trimmedArgv.filter(
      (_, index) =>
        index > 1 &&
        index !== repoFlagIndex &&
        index !== repoFlagIndex + 1 &&
        index !== workspaceFlagIndex &&
        index !== workspaceFlagIndex + 1 &&
        index !== runnerFlagIndex &&
        index !== runnerFlagIndex + 1,
    );
    const prompt = promptParts.join(" ").trim();

    if (repoId !== undefined && repoId.length === 0) {
      throw new Error("Repo id cannot be empty.\n\n" + getHelpText());
    }

    if (workspaceId !== undefined && workspaceId.length === 0) {
      throw new Error("Workspace id cannot be empty.\n\n" + getHelpText());
    }

    if (prompt.length === 0) {
      throw new Error("Task prompt cannot be empty.\n\n" + getHelpText());
    }

    return {
      mode: "command",
      command: { kind: "createTask", ...(repoId ? { repoId } : {}), ...(workspaceId ? { workspaceId } : {}), prompt, ...(runner ? { runner } : {}) },
    };
  }

  if (
    trimmedArgv.length >= 2 &&
    trimmedArgv.length <= 4 &&
    trimmedArgv[0] === "task" &&
    trimmedArgv[1] === "list"
  ) {
    if (trimmedArgv.length === 2) {
      return { mode: "command", command: { kind: "listTasks" } };
    }

    if (trimmedArgv.length === 4 && trimmedArgv[2] === "--repo") {
      return { mode: "command", command: { kind: "listTasks", repoId: trimmedArgv[3]!.trim() } };
    }

    throw new Error(`Unsupported command: ${trimmedArgv.join(" ")}\n\n${getHelpText()}`);
  }

  if (trimmedArgv.length === 3 && trimmedArgv[0] === "task" && trimmedArgv[1] === "attach") {
    return { mode: "command", command: { kind: "attachTask", taskId: requireTaskId(trimmedArgv[2]!) } };
  }

  if (trimmedArgv.length === 3 && trimmedArgv[0] === "task" && trimmedArgv[1] === "show") {
    return {
      mode: "command",
      command: { kind: "showTask", taskId: requireTaskId(trimmedArgv[2]!) },
    };
  }

  if (trimmedArgv.length === 3 && trimmedArgv[0] === "task" && trimmedArgv[1] === "logs") {
    return {
      mode: "command",
      command: { kind: "streamTaskLogs", taskId: requireTaskId(trimmedArgv[2]!) },
    };
  }

  if (trimmedArgv.length === 3 && trimmedArgv[0] === "task" && trimmedArgv[1] === "diff") {
    return {
      mode: "command",
      command: { kind: "showTaskDiff", taskId: requireTaskId(trimmedArgv[2]!) },
    };
  }

  if (trimmedArgv.length === 3 && trimmedArgv[0] === "task" && trimmedArgv[1] === "focus") {
    return {
      mode: "command",
      command: { kind: "focusTask", taskId: requireTaskId(trimmedArgv[2]!) },
    };
  }

  if (trimmedArgv.length === 3 && trimmedArgv[0] === "task" && trimmedArgv[1] === "open") {
    return {
      mode: "command",
      command: { kind: "openTask", taskId: requireTaskId(trimmedArgv[2]!) },
    };
  }

  if (trimmedArgv.length === 3 && trimmedArgv[0] === "task" && trimmedArgv[1] === "check") {
    return {
      mode: "command",
      command: { kind: "runChecks", taskId: requireTaskId(trimmedArgv[2]!) },
    };
  }

  if (trimmedArgv.length === 3 && trimmedArgv[0] === "task" && trimmedArgv[1] === "commit") {
    return {
      mode: "command",
      command: { kind: "commitTask", taskId: requireTaskId(trimmedArgv[2]!) },
    };
  }

  if (trimmedArgv.length === 4 && trimmedArgv[0] === "link" && trimmedArgv[1] === "add") {
    return {
      mode: "command",
      command: {
        kind: "addTaskLink",
        taskId: requireTaskId(trimmedArgv[2]!),
        repoId: requireRepoId(trimmedArgv[3]!),
      },
    };
  }

  if (trimmedArgv.length === 3 && trimmedArgv[0] === "link" && trimmedArgv[1] === "list") {
    return {
      mode: "command",
      command: {
        kind: "listTaskLinks",
        taskId: requireTaskId(trimmedArgv[2]!),
      },
    };
  }

  throw new Error(`Unsupported command: ${trimmedArgv.join(" ")}\n\n${getHelpText()}`);
}

export function getHelpText(): string {
  return [
    "Craig commands:",
    "  craig              Show the Craig phase 0 placeholder",
    "  craig repo add     Register a repo in the current Craig workspace",
    "  craig workspace add <path>  Register a repo or parent-directory workspace",
    "  craig repo list    List registered repos",
    "  craig repo remove  Remove a registered repo",
    "  craig workspace list      List active workspaces",
    "  craig workspace list --archived  List archived workspaces",
    "  craig workspace archive   Archive a workspace",
    "  craig workspace restore   Restore an archived workspace",
    "  craig workspace remove    Remove an archived workspace",
    "  craig task new --repo <repo-id> [--runner codex|cursor|claude] <prompt>  Create a new Craig repo task",
    "  craig task new --workspace <workspace-id> [--runner codex|cursor|claude] <prompt>  Create a new Craig workspace task",
    "  craig task list [--repo <repo-id>]  List known Craig tasks",
    "  craig task show    Show details for a Craig task",
    "  craig task logs    Stream Craig-managed logs for a task",
    "  craig task diff    Show the current worktree diff for a task",
    "  craig task attach  Attach to a live task session",
    "  craig task focus   Focus the tmux pane for a task",
    "  craig task open    Open the task worktree or print its path",
    "  craig task check   Run configured checks for a task",
    "  craig task commit  Commit all task worktree changes",
    "  craig link add     Add a linked repo to a task",
    "  craig link list    List linked repos for a task",
  ].join("\n");
}

function requireTaskId(value: string): string {
  const taskId = value.trim();

  if (taskId.length === 0) {
    throw new Error(`Task id cannot be empty.\n\n${getHelpText()}`);
  }

  return taskId;
}

function requireRepoId(value: string): string {
  const repoId = value.trim();

  if (repoId.length === 0) {
    throw new Error(`Repo id cannot be empty.\n\n${getHelpText()}`);
  }

  return repoId;
}
