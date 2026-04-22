import type { AppCommand } from "../types/command.js";

export function parseReplCommand(input: string): AppCommand {
  const normalized = input.trim();

  if (normalized === "show") {
    return { kind: "showSelectedTask" };
  }

  if (normalized.startsWith("show ")) {
    return { kind: "showTask", taskId: requireTaskId(normalized.slice(5)) };
  }

  if (normalized === "logs") {
    return { kind: "streamSelectedTaskLogs" };
  }

  if (normalized.startsWith("logs ")) {
    return { kind: "streamTaskLogs", taskId: requireTaskId(normalized.slice(5)) };
  }

  if (normalized === "diff") {
    return { kind: "showSelectedTaskDiff" };
  }

  if (normalized.startsWith("diff ")) {
    return { kind: "showTaskDiff", taskId: requireTaskId(normalized.slice(5)) };
  }

  if (normalized === "focus") {
    return { kind: "focusSelectedTask" };
  }

  if (normalized.startsWith("focus ")) {
    return { kind: "focusTask", taskId: requireTaskId(normalized.slice(6)) };
  }

  if (normalized === "open") {
    return { kind: "openSelectedTask" };
  }

  if (normalized.startsWith("open ")) {
    return { kind: "openTask", taskId: requireTaskId(normalized.slice(5)) };
  }

  if (normalized === "check") {
    return { kind: "runSelectedTaskChecks" };
  }

  if (normalized.startsWith("check ")) {
    return { kind: "runChecks", taskId: requireTaskId(normalized.slice(6)) };
  }

  if (normalized === "commit") {
    return { kind: "commitSelectedTask" };
  }

  if (normalized.startsWith("commit ")) {
    return { kind: "commitTask", taskId: requireTaskId(normalized.slice(7)) };
  }

  if (normalized === "pr") {
    return { kind: "openSelectedTaskPullRequest", watch: false };
  }

  if (normalized.startsWith("pr ")) {
    return parsePullRequestCommand(normalized.slice(3));
  }

  if (normalized === "merge") {
    return { kind: "mergeSelectedTask", preserveWorktree: false };
  }

  if (normalized.startsWith("merge ")) {
    return parseMergeCommand(normalized.slice(6));
  }

  if (normalized === "new") {
    throw new Error("Task title cannot be empty.");
  }

  if (normalized.startsWith("new ")) {
    const title = normalized.slice(4).trim();

    if (title.length === 0) {
      throw new Error("Task title cannot be empty.");
    }

    return { kind: "createTask", title };
  }

  if (normalized === "list") {
    return { kind: "listTasks" };
  }

  if (normalized === "refresh") {
    return { kind: "refreshInteractiveState" };
  }

  if (normalized === "help") {
    return { kind: "help" };
  }

  if (normalized === "exit") {
    return { kind: "exit" };
  }

  throw new Error(`Unknown command: ${normalized || "<empty>"}. Type 'help' for available commands.`);
}

function requireTaskId(value: string): string {
  const taskId = value.trim();

  if (taskId.length === 0) {
    throw new Error("Task id cannot be empty.");
  }

  return taskId;
}

function parsePullRequestCommand(value: string) {
  const parts = value.trim().split(/\s+/).filter(Boolean);
  const watch = parts.at(-1) === "--watch";
  const taskId = parts[0];

  if (parts.length > 2 || (parts.length === 2 && !watch)) {
    throw new Error(`Unknown command: pr ${value.trim()}. Type 'help' for available commands.`);
  }

  if (!taskId || taskId === "--watch") {
    return {
      kind: "openSelectedTaskPullRequest" as const,
      watch,
    };
  }

  return {
    kind: "openPullRequest" as const,
    taskId,
    watch,
  };
}

function parseMergeCommand(value: string) {
  const parts = value.trim().split(/\s+/).filter(Boolean);
  const preserveWorktree = parts.at(-1) === "--preserve-worktree";
  const taskId = parts[0];

  if (parts.length > 2 || (parts.length === 2 && !preserveWorktree)) {
    throw new Error(`Unknown command: merge ${value.trim()}. Type 'help' for available commands.`);
  }

  if (!taskId || taskId === "--preserve-worktree") {
    return {
      kind: "mergeSelectedTask" as const,
      preserveWorktree,
    };
  }

  return {
    kind: "mergeTask" as const,
    taskId,
    preserveWorktree,
  };
}
