import type { AppCommand } from "../types/command.js";

export function parseReplCommand(input: string): AppCommand {
  const normalized = input.trim();

  if (normalized === "help") {
    return { kind: "help" };
  }

  if (normalized === "exit") {
    return { kind: "exit" };
  }

  if (normalized === "refresh") {
    return { kind: "refreshInteractiveState" };
  }

  if (normalized === "repo list") {
    return { kind: "listRepos" };
  }

  if (normalized.startsWith("repo add ")) {
    const value = normalized.slice("repo add ".length).trim();

    if (value.length === 0) {
      throw new Error("Repo path cannot be empty.");
    }

    return { kind: "addRepo", path: value };
  }

  if (normalized.startsWith("repo remove ")) {
    const value = normalized.slice("repo remove ".length).trim();

    if (value.length === 0) {
      throw new Error("Repo id cannot be empty.");
    }

    return { kind: "removeRepo", repoId: value };
  }

  if (normalized === "workspace list") {
    return { kind: "listWorkspaces", archived: false };
  }

  if (normalized === "workspace list --archived") {
    return { kind: "listWorkspaces", archived: true };
  }

  if (normalized.startsWith("workspace archive ")) {
    const value = normalized.slice("workspace archive ".length).trim();

    if (value.length === 0) {
      throw new Error("Workspace id cannot be empty.");
    }

    return { kind: "archiveWorkspace", workspaceId: value };
  }

  if (normalized.startsWith("workspace restore ")) {
    const value = normalized.slice("workspace restore ".length).trim();

    if (value.length === 0) {
      throw new Error("Workspace id cannot be empty.");
    }

    return { kind: "restoreWorkspace", workspaceId: value };
  }

  if (normalized.startsWith("task new ")) {
    const parts = normalized.split(/\s+/);
    const repoFlagIndex = parts.indexOf("--repo");

    if (repoFlagIndex === -1) {
      throw new Error("Task creation now requires '--repo <repo-id>'.");
    }

    const repoId = parts[repoFlagIndex + 1]?.trim() ?? "";
    const prompt = parts.filter((_, index) => index > 1 && index !== repoFlagIndex && index !== repoFlagIndex + 1).join(" ").trim();

    if (repoId.length === 0) {
      throw new Error("Repo id cannot be empty.");
    }

    if (prompt.length === 0) {
      throw new Error("Task prompt cannot be empty.");
    }

    return { kind: "createTask", repoId, prompt };
  }

  if (normalized === "task list") {
    return { kind: "listTasks" };
  }

  if (normalized.startsWith("task list --repo ")) {
    const repoId = normalized.slice("task list --repo ".length).trim();

    if (repoId.length === 0) {
      throw new Error("Repo id cannot be empty.");
    }

    return { kind: "listTasks", repoId };
  }

  if (normalized.startsWith("task attach ")) {
    const taskId = normalized.slice("task attach ".length).trim();

    if (taskId.length === 0) {
      throw new Error("Task id cannot be empty.");
    }

    return { kind: "attachTask", taskId };
  }

  if (normalized === "show") {
    return { kind: "showSelectedTask" };
  }

  if (normalized.startsWith("show ")) {
    const taskId = normalized.slice("show ".length).trim();

    if (taskId.length === 0) {
      throw new Error("Task id cannot be empty.");
    }

    return { kind: "showTask", taskId };
  }

  if (normalized === "logs") {
    return { kind: "streamSelectedTaskLogs" };
  }

  if (normalized.startsWith("logs ")) {
    const taskId = normalized.slice("logs ".length).trim();

    if (taskId.length === 0) {
      throw new Error("Task id cannot be empty.");
    }

    return { kind: "streamTaskLogs", taskId };
  }

  if (normalized === "diff") {
    return { kind: "showSelectedTaskDiff" };
  }

  if (normalized.startsWith("diff ")) {
    const taskId = normalized.slice("diff ".length).trim();

    if (taskId.length === 0) {
      throw new Error("Task id cannot be empty.");
    }

    return { kind: "showTaskDiff", taskId };
  }

  if (normalized === "focus") {
    return { kind: "focusSelectedTask" };
  }

  if (normalized.startsWith("focus ")) {
    const taskId = normalized.slice("focus ".length).trim();

    if (taskId.length === 0) {
      throw new Error("Task id cannot be empty.");
    }

    return { kind: "focusTask", taskId };
  }

  if (normalized === "open") {
    return { kind: "openSelectedTask" };
  }

  if (normalized.startsWith("open ")) {
    const taskId = normalized.slice("open ".length).trim();

    if (taskId.length === 0) {
      throw new Error("Task id cannot be empty.");
    }

    return { kind: "openTask", taskId };
  }

  if (normalized === "check") {
    return { kind: "runSelectedTaskChecks" };
  }

  if (normalized.startsWith("check ")) {
    const taskId = normalized.slice("check ".length).trim();

    if (taskId.length === 0) {
      throw new Error("Task id cannot be empty.");
    }

    return { kind: "runChecks", taskId };
  }

  if (normalized === "commit") {
    return { kind: "commitSelectedTask" };
  }

  if (normalized.startsWith("commit ")) {
    const taskId = normalized.slice("commit ".length).trim();

    if (taskId.length === 0) {
      throw new Error("Task id cannot be empty.");
    }

    return { kind: "commitTask", taskId };
  }

  if (normalized === "pr") {
    return { kind: "openSelectedTaskPullRequest", watch: false };
  }

  if (normalized === "pr --watch") {
    return { kind: "openSelectedTaskPullRequest", watch: true };
  }

  if (normalized.startsWith("pr ")) {
    const parts = normalized.slice("pr ".length).trim().split(/\s+/);
    const [taskId = "", watchFlag = ""] = parts;

    if (taskId.length === 0) {
      throw new Error("Task id cannot be empty.");
    }

    if (watchFlag.length > 0 && watchFlag !== "--watch") {
      throw new Error("Usage: pr [task-id] [--watch]");
    }

    return { kind: "openPullRequest", taskId, watch: watchFlag === "--watch" };
  }

  if (normalized === "merge") {
    return { kind: "mergeSelectedTask", preserveWorktree: false };
  }

  if (normalized === "merge --preserve-worktree") {
    return { kind: "mergeSelectedTask", preserveWorktree: true };
  }

  if (normalized.startsWith("merge ")) {
    const parts = normalized.slice("merge ".length).trim().split(/\s+/);
    const [taskId = "", preserveFlag = ""] = parts;

    if (taskId.length === 0) {
      throw new Error("Task id cannot be empty.");
    }

    if (preserveFlag.length > 0 && preserveFlag !== "--preserve-worktree") {
      throw new Error("Usage: merge [task-id] [--preserve-worktree]");
    }

    return { kind: "mergeTask", taskId, preserveWorktree: preserveFlag === "--preserve-worktree" };
  }

  if (normalized.startsWith("link add ")) {
    const [taskId = "", repoId = ""] = normalized.slice("link add ".length).trim().split(/\s+/, 2);

    if (taskId.length === 0 || repoId.length === 0) {
      throw new Error("Usage: link add <task-id> <repo-id>");
    }

    return { kind: "addTaskLink", taskId, repoId };
  }

  if (normalized.startsWith("link list ")) {
    const taskId = normalized.slice("link list ".length).trim();

    if (taskId.length === 0) {
      throw new Error("Task id cannot be empty.");
    }

    return { kind: "listTaskLinks", taskId };
  }

  throw new Error(`Unknown command: ${normalized || "<empty>"}. Type 'help' for available commands.`);
}
