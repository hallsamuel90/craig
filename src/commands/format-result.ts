import type { CommandResult } from "./types.js";

export function formatCommandResult(result: CommandResult): string {
  switch (result.kind) {
    case "createWorkspace":
      return [
        `${result.created ? "Registered" : "Updated"} ${result.workspace.kind ?? "repo"} workspace ${result.workspace.id}`,
        `Path: ${result.workspace.rootPath ?? ""}`,
        `Repos: ${result.repos.map((repo) => repo.id).join(", ")}`,
      ].join("\n");
    case "createRepo":
      return [
        `${result.created ? "Registered" : "Already registered"} repo ${result.repo.id}`,
        `Path: ${result.repo.rootPath}`,
        `Branch: ${result.repo.defaultBranch}`,
        `Workspace: ${result.workspaceId}`,
      ].join("\n");
    case "listRepos":
      if (result.repos.length === 0) {
        return "No repos registered yet. Use 'craig repo add <path>'.";
      }

      return ["ID\tNAME\tBRANCH\tPATH", ...result.repos.map((repo) => `${repo.id}\t${repo.name}\t${repo.defaultBranch}\t${repo.rootPath}`)].join(
        "\n",
      );
    case "removeRepo":
      return `Removed repo ${result.repoId} (${result.rootPath})`;
    case "listWorkspaces":
      if (result.workspaces.length === 0) {
        return result.archivedOnly
          ? "No archived workspaces."
          : "No active workspaces yet. Register one with 'craig workspace add <path>'.";
      }

      return [
        "ID\tKIND\tSTATUS\tREPOS\tPATH",
        ...result.workspaces.map((workspace) => `${workspace.id}\t${workspace.kind ?? "repo"}\t${workspace.status}\t${(workspace.discoveredRepoIds ?? [workspace.primaryRepoId]).join(",")}\t${workspace.rootPath ?? ""}`),
      ].join("\n");
    case "archiveWorkspace":
      return `Archived workspace ${result.workspaceId} on branch ${result.branch}`;
    case "restoreWorkspace":
      return `Restored workspace ${result.workspaceId} on branch ${result.branch}`;
    case "removeWorkspace":
      return `Removed workspace ${result.workspaceId} (${result.rootPath})`;
    case "createTask":
      return [
        `Created task ${result.taskId}`,
        `Repo: ${result.repoId}`,
        `Workspace: ${result.workspaceId}`,
        `Session: ${result.sessionId}`,
        `Status: ${result.status}`,
        `Branch: ${result.branch}`,
        `Worktree: ${result.worktreePath}`,
        `Runner: ${result.runner}`,
      ].join("\n");
    case "attachTask":
      return `Attached to task ${result.taskId} via session ${result.sessionId}`;
    case "addTaskLink":
      return `Linked repo ${result.repoId} to task ${result.taskId}: ${result.linkedRepoIds.join(", ")}`;
    case "listTaskLinks":
      if (result.repos.length === 0) {
        return `Task ${result.taskId} has no linked repos.`;
      }

      return ["ID\tNAME\tBRANCH\tPATH", ...result.repos.map((repo) => `${repo.id}\t${repo.name}\t${repo.defaultBranch}\t${repo.rootPath}`)].join(
        "\n",
      );
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

        return `No Craig tasks yet. Use 'task new --repo <repo-id> <prompt>' to create one.${suffix}`;
      }

      return [
        "ID\tREPO\tSTATUS\tCHECKS\tPR\tTITLE",
        ...result.tasks.map(
          (task) =>
            `${task.id}\t${task.repoId}\t${task.status}\t${summarizeListChecks(task)}\t${summarizeListPr(task)}\t${task.title}`,
        ),
      ].join("\n");
    case "showTask":
      return [
        `${result.task.id}: ${result.task.title}`,
        `Status: ${result.task.status}`,
        `Runner: ${result.task.runner}`,
        `Repo: ${result.task.repoId}`,
        `Workspace: ${result.task.workspaceId}`,
        `Branch: ${result.task.branch}`,
        `Worktree: ${result.task.worktreePath}`,
        `Session: ${result.task.sessionId ?? "<missing>"}`,
        `tmux: ${result.session?.paneId ?? "<missing>"}`,
        `Linked repos: ${result.task.linkedRepoIds.length > 0 ? result.task.linkedRepoIds.join(", ") : "none"}`,
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
    case "currentTask":
      return [
        `${result.task.id}: ${result.task.title}`,
        `Workspace: ${result.task.workspaceId}`,
        `Repo: ${result.task.repoId}`,
        `Worktree: ${result.task.worktreePath}`,
        `Context source: ${result.context.source}`,
        `Agent tab: ${result.context.agentTabId ?? "none"}`,
      ].join("\n");
    case "showTaskPr":
    case "discoverTaskPr":
    case "linkTaskPr":
    case "refreshTaskPr":
    case "unlinkTaskPr":
      return formatTaskPrResult(result);
    case "listAgents":
    case "showAgentStatus":
      return formatAgentStatuses(result);
    case "waitTask":
      return `Task ${result.taskId}${result.tabId ? ` tab ${result.tabId}` : ""} reached ${result.state}.`;
    case "listEvents":
      return result.events.length === 0
        ? "No events found."
        : result.events.map(formatEventLine).join("\n");
    case "watchEvents":
      return "";
    case "sendAgentPrompt":
      return `${result.created ? "Queued" : "Found"} command ${result.command.id} for task ${result.command.taskId} tab ${result.command.agentTabId}.`;
    case "showPromptCommand":
      return formatPromptCommand(result.command);
    case "listPromptCommands":
      return result.commands.length === 0
        ? "No prompt commands found."
        : ["ID\tTASK\tTAB\tSTATE\tDELIVERY\tATTEMPTS", ...result.commands.map((command) =>
            `${command.id}\t${command.taskId}\t${command.agentTabId}\t${command.state}\t${command.delivery}\t${command.attempts}`)]
            .join("\n");
    case "cancelPromptCommand":
      return `${result.changed ? "Cancelled" : "Command already cancelled:"} ${result.command.id}`;
    case "waitPromptCommand":
      return `Command ${result.command.id} reached ${result.command.state}.`;
    case "showContext":
      return [
        `Workspace: ${result.workspace.root}`,
        `Workspace source: ${result.workspace.source}`,
        `Initialized: ${result.workspace.initialized ? "yes" : "no"}`,
        `Task: ${result.task?.id ?? "none"}`,
        `Task source: ${result.task?.source ?? "none"}`,
        `Agent tab: ${result.task?.agentTabId ?? "none"}`,
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
    default:
      return assertNever(result);
  }
}

function formatPromptCommand(command: Extract<CommandResult, { kind: "showPromptCommand" }>["command"]): string {
  return [
    `${command.id}: ${command.state}`,
    `Task: ${command.taskId}`,
    `Agent tab: ${command.agentTabId}`,
    `Delivery: ${command.delivery}`,
    `Attempts: ${command.attempts}`,
    `Prompt source: ${command.prompt.source}`,
    `Prompt bytes: ${Buffer.byteLength(command.prompt.text)}`,
    `Created: ${command.createdAt}`,
    `Updated: ${command.updatedAt}`,
    `Error: ${command.lastError?.message ?? "none"}`,
  ].join("\n");
}

export function formatEventLine(event: { sequence: number; occurredAt: string; type: string; taskId: string | null }): string {
  return `${event.sequence}\t${event.occurredAt}\t${event.type}\t${event.taskId ?? "-"}`;
}

function formatAgentStatuses(
  result: Extract<CommandResult, { kind: "listAgents" | "showAgentStatus" }>,
): string {
  if (result.agents.length === 0) return "No agent tabs found.";
  return [
    "TASK\tTAB\tRUNNER\tSTATE\tSESSION\tERROR",
    ...result.agents.map((agent) =>
      `${agent.taskId}\t${agent.tabId}\t${agent.runner}\t${agent.state}\t${agent.sessionState ?? "none"}\t${agent.error ?? ""}`),
    ...(!result.daemonAvailable ? ["Warning: PTY daemon unavailable; live agent tabs report idle unless a durable startup failure exists."] : []),
  ].join("\n");
}

function formatTaskPrResult(
  result: Extract<CommandResult, {
    kind: "showTaskPr" | "discoverTaskPr" | "linkTaskPr" | "refreshTaskPr" | "unlinkTaskPr";
  }>,
): string {
  const summary = `${result.taskId} (${result.repoId}): ${result.disposition}`;
  const rows = result.pullRequests.length === 0
    ? ["No pull requests associated."]
    : [
        "PR\tSTATUS\tHEAD\tURL",
        ...result.pullRequests.map((pr) =>
          `#${pr.number ?? "-"}\t${pr.status ?? "unknown"}\t${pr.headBranch ?? "-"}\t${pr.url ?? "-"}`
        ),
      ];
  return [summary, ...rows, ...result.warnings.map((warning) => `Warning: ${warning}`)].join("\n");
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
  if (task.type === "project" && task.repoTargets?.length) {
    const linked = task.repoTargets.filter((t) => t.pullRequest.number);
    if (linked.length === 0) return "-";
    const statusCounts = linked.reduce<Record<string, number>>((acc, t) => {
      const s = t.pullRequest.status ?? "unknown";
      acc[s] = (acc[s] ?? 0) + 1;
      return acc;
    }, {});
    return Object.entries(statusCounts).map(([s, n]) => `${n} ${s}`).join(", ");
  }

  const pr = task.prs[0];
  if (!pr?.number) {
    return "-";
  }

  return `#${pr.number}:${pr.status ?? "unknown"}`;
}
