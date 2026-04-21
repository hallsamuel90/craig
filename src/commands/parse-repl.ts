import type { AppCommand } from "../types/command.js";

export function parseReplCommand(input: string): AppCommand {
  const normalized = input.trim();

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
