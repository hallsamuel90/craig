import type { AppCommand } from "../types/command.js";

export function parseReplCommand(input: string): AppCommand {
  const normalized = input.trim();

  if (normalized === "show") {
    throw new Error("Task id cannot be empty.");
  }

  if (normalized.startsWith("show ")) {
    return { kind: "showTask", taskId: requireTaskId(normalized.slice(5)) };
  }

  if (normalized === "logs") {
    throw new Error("Task id cannot be empty.");
  }

  if (normalized.startsWith("logs ")) {
    return { kind: "streamTaskLogs", taskId: requireTaskId(normalized.slice(5)) };
  }

  if (normalized === "diff") {
    throw new Error("Task id cannot be empty.");
  }

  if (normalized.startsWith("diff ")) {
    return { kind: "showTaskDiff", taskId: requireTaskId(normalized.slice(5)) };
  }

  if (normalized === "focus") {
    throw new Error("Task id cannot be empty.");
  }

  if (normalized.startsWith("focus ")) {
    return { kind: "focusTask", taskId: requireTaskId(normalized.slice(6)) };
  }

  if (normalized === "open") {
    throw new Error("Task id cannot be empty.");
  }

  if (normalized.startsWith("open ")) {
    return { kind: "openTask", taskId: requireTaskId(normalized.slice(5)) };
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
