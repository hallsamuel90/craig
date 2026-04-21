import type { AppCommand } from "../types/command.js";

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

  if (trimmedArgv.length >= 2 && trimmedArgv[0] === "task" && trimmedArgv[1] === "new") {
    const title = trimmedArgv.slice(2).join(" ").trim();

    if (title.length === 0) {
      throw new Error("Task title cannot be empty.\n\n" + getHelpText());
    }

    return { mode: "command", command: { kind: "createTask", title } };
  }

  if (trimmedArgv.length === 2 && trimmedArgv[0] === "task" && trimmedArgv[1] === "list") {
    return { mode: "command", command: { kind: "listTasks" } };
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

  throw new Error(`Unsupported command: ${trimmedArgv.join(" ")}\n\n${getHelpText()}`);
}

export function getHelpText(): string {
  return [
    "Craig commands:",
    "  craig              Start the Craig REPL",
    "  craig task new     Create a new Craig task",
    "  craig task list    List known Craig tasks",
    "  craig task show    Show details for a Craig task",
    "  craig task logs    Stream Craig-managed logs for a task",
    "  craig task diff    Show the current worktree diff for a task",
    "  craig task focus   Focus the tmux pane for a task",
    "  craig task open    Open the task worktree or print its path",
    "",
    "REPL commands:",
    "  new <task>",
    "  list",
    "  show <id>",
    "  logs <id>",
    "  diff <id>",
    "  focus <id>",
    "  open <id>",
    "  help",
    "  exit",
  ].join("\n");
}

function requireTaskId(value: string): string {
  const taskId = value.trim();

  if (taskId.length === 0) {
    throw new Error(`Task id cannot be empty.\n\n${getHelpText()}`);
  }

  return taskId;
}
