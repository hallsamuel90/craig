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
        "ID\tSTATUS\tCHECKS\tPR\tTITLE",
        ...result.tasks.map(
          (task) =>
            `${task.id}\t${task.status}\t${summarizeListChecks(task)}\t${summarizeListPr(task)}\t${task.title}`,
        ),
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
        `Last commit: ${result.inspection.lastCommitSummary}`,
        `PR: ${result.inspection.prSummary}`,
        `Cleanup: ${result.inspection.cleanupSummary}`,
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
    case "runChecks":
      return `Checks ${result.status} for ${result.taskId}: ${result.commands.join(", ")}`;
    case "commitTask":
      return [
        `Committed task ${result.taskId}`,
        `Status: ${result.status}`,
        `Commit: ${result.commitSha}`,
        `Message: ${result.message}`,
      ].join("\n");
    case "openPullRequest":
      return [
        `${result.watch ? "Watched" : "Updated"} PR for ${result.taskId}`,
        `PR: #${result.prNumber} ${result.url}`,
        `Status: ${result.status}`,
        `Mergeable: ${result.mergeable}`,
        `Checks: ${result.requiredChecksSummary}`,
      ].join("\n");
    case "mergeTask":
      return [
        `Merged task ${result.taskId} from PR #${result.prNumber}`,
        `Status: ${result.status}`,
        `Preserved worktree: ${result.preservedWorktree}`,
        `Cleanup warning: ${result.cleanupWarning ?? "none"}`,
      ].join("\n");
    default:
      return assertNever(result);
  }
}

function buildShowWarnings(result: Extract<CommandResult, { kind: "showTask" }>): string[] {
  const warnings: string[] = [];

  if (!result.inspection.worktreeExists) {
    const intentionallyCleanedUp =
      result.task.status === "merged" &&
      !result.task.cleanup.preservedWorktree &&
      Boolean(result.task.cleanup.worktreeRemovedAt);

    if (!intentionallyCleanedUp) {
      warnings.push(`Warning: worktree is missing at ${result.task.worktreePath}`);
    }
  }

  if (
    result.task.cleanup.warning &&
    !(result.task.status === "merged" && !result.task.cleanup.worktreeRemovedAt)
  ) {
    warnings.push(`Cleanup warning: ${result.task.cleanup.warning}`);
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

function summarizeListChecks(task: Extract<CommandResult, { kind: "listTasks" }>["tasks"][number]): string {
  return task.checks.status;
}

function summarizeListPr(task: Extract<CommandResult, { kind: "listTasks" }>["tasks"][number]): string {
  if (!task.pullRequest.number) {
    return "-";
  }

  return `#${task.pullRequest.number}:${task.pullRequest.status ?? "unknown"}`;
}
