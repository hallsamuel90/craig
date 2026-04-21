import type { CommandResult } from "./types/command.js";

export function formatCommandResult(result: CommandResult): string {
  switch (result.kind) {
    case "createTask":
      return [
        `Created task ${result.taskId}`,
        `Status: ${result.status}`,
        `Branch: ${result.branch}`,
        `Worktree: ${result.worktreePath}`,
        `tmux: ${result.tmuxTarget}`,
        `Runner: ${result.runner}`,
      ].join("\n");
    case "help":
      return result.text;
    case "exit":
      return "";
    case "listTasks":
      if (result.tasks.length === 0) {
        const suffix =
          result.missingTaskIds.length > 0
            ? ` (${result.missingTaskIds.length} referenced task file(s) missing from .craig/tasks)` 
            : "";

        return `No Craig tasks yet. Use 'new <task>' to create one.${suffix}`;
      }

      return [
        "ID\tSTATUS\tTITLE",
        ...result.tasks.map((task) => `${task.id}\t${task.status}\t${task.title}`),
      ].join("\n");
    default:
      return assertNever(result);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unsupported result: ${JSON.stringify(value)}`);
}
