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
    case "showTask":
      return [
        `${result.task.id}: ${result.task.title}`,
        `Status: ${result.task.status}`,
        `Runner: ${result.task.runner}`,
        `Branch: ${result.task.branch}`,
        `Worktree: ${result.task.worktreePath}`,
        `tmux: ${result.task.tmuxTarget || "<missing>"}`,
        `Prompt: ${result.task.prompt.source} ${JSON.stringify(result.task.prompt.value)}`,
        `Runner command: ${result.inspection.runnerCommandText || "<none>"}`,
        `Runner state: ${result.task.runnerSession.lastKnownState}`,
        `Started: ${result.task.runnerSession.startedAt ?? "not started"}`,
        `Exited: ${result.task.runnerSession.exitedAt ?? "still running"}`,
        `Checks: ${result.inspection.checksSummary}`,
        `PR: ${result.inspection.prSummary}`,
        ...buildShowWarnings(result),
      ].join("\n");
    case "streamTaskLogs":
      return `Streaming logs for ${result.taskId} from ${result.logPath}`;
    case "showTaskDiff":
      return result.isEmpty ? `Task ${result.taskId} has no uncommitted diff.` : result.diffText;
    case "focusTask":
      return `Focused task ${result.taskId} on ${result.tmuxTarget}`;
    case "openTask":
      return result.launched
        ? `Opened task ${result.taskId} at ${result.worktreePath}`
        : result.worktreePath;
    default:
      return assertNever(result);
  }
}

function buildShowWarnings(result: Extract<CommandResult, { kind: "showTask" }>): string[] {
  const warnings: string[] = [];

  if (!result.inspection.worktreeExists) {
    warnings.push(`Warning: worktree is missing at ${result.task.worktreePath}`);
  }

  if (result.task.artifacts.logPath && !result.inspection.logExists) {
    warnings.push(`Warning: log file is missing at ${result.task.artifacts.logPath}`);
  }

  if (result.inspection.recentFailureReason) {
    warnings.push(`Last failure: ${result.inspection.recentFailureReason}`);
  }

  return warnings;
}

function assertNever(value: never): never {
  throw new Error(`Unsupported result: ${JSON.stringify(value)}`);
}
