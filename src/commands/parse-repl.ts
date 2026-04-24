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

  throw new Error(`Unknown command: ${normalized || "<empty>"}. Type 'help' for available commands.`);
}
