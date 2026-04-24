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
