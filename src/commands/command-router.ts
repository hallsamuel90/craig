import type { CommandResult, AppCommand } from "../types/command.js";
import type { CraigPaths } from "../state/craig-paths.js";
import { getHelpText } from "./parse-argv.js";
import { createTask } from "../services/create-task.js";
import { listTasks } from "../services/list-tasks.js";
import { attachTask } from "../services/attach-task.js";
import { showTask } from "../services/show-task.js";
import { prepareTaskLogs } from "../services/stream-task-logs.js";
import { showTaskDiff } from "../services/show-task-diff.js";
import { focusTask } from "../services/focus-task.js";
import { openTask } from "../services/open-task.js";
import { runChecks } from "../services/run-checks.js";
import { commitTask } from "../services/commit-task.js";
import { openPullRequest } from "../services/open-pull-request.js";
import { mergeTask } from "../services/merge-task.js";
import { addRepo, listRegisteredRepos, removeRepo } from "../services/repo-registry.js";
import { addTaskLink, listTaskLinks } from "../services/task-links.js";
import { addWorkspace, archiveWorkspace, listWorkspaces, restoreWorkspace } from "../services/workspace-registry.js";

export interface CommandContext {
  paths: CraigPaths;
  selectedTaskId?: string | null;
}

export async function executeCommand(
  command: AppCommand,
  context: CommandContext,
): Promise<CommandResult> {
  switch (command.kind) {
    case "addWorkspace":
      return addWorkspace(context.paths, command.path);
    case "addRepo":
      return addRepo(context.paths, command.path);
    case "listRepos":
      return listRegisteredRepos(context.paths);
    case "removeRepo":
      return removeRepo(context.paths, command.repoId);
    case "listWorkspaces":
      return listWorkspaces(context.paths, { archived: command.archived });
    case "archiveWorkspace":
      return archiveWorkspace(context.paths, command.workspaceId);
    case "restoreWorkspace":
      return restoreWorkspace(context.paths, command.workspaceId);
    case "createTask":
      return createTask(
        context.paths,
        command.repoId ?? command.workspaceId ?? "",
        command.prompt,
        { ...(command.runner ? { runner: command.runner } : {}), ...(command.workspaceId ? { workspaceId: command.workspaceId } : {}) },
      );
    case "listTasks":
      return command.repoId || command.workspaceId
        ? listTasks(context.paths, { ...(command.repoId ? { repoId: command.repoId } : {}), ...(command.workspaceId ? { workspaceId: command.workspaceId } : {}) })
        : listTasks(context.paths);
    case "attachTask":
      return attachTask(context.paths, command.taskId);
    case "addTaskLink":
      return addTaskLink(context.paths, command.taskId, command.repoId);
    case "listTaskLinks":
      return listTaskLinks(context.paths, command.taskId);
    case "refreshInteractiveState":
      throw new Error("Interactive refresh should be handled by the interactive app.");
    case "showTask":
      return showTask(context.paths, command.taskId);
    case "showSelectedTask":
      return showTask(context.paths, requireSelectedTaskId(context, "show"));
    case "streamTaskLogs":
      return prepareTaskLogs(context.paths, command.taskId);
    case "streamSelectedTaskLogs":
      return prepareTaskLogs(context.paths, requireSelectedTaskId(context, "logs"));
    case "showTaskDiff":
      return showTaskDiff(context.paths, command.taskId);
    case "showSelectedTaskDiff":
      return showTaskDiff(context.paths, requireSelectedTaskId(context, "diff"));
    case "focusTask":
      return focusTask(context.paths, command.taskId);
    case "focusSelectedTask":
      return focusTask(context.paths, requireSelectedTaskId(context, "focus"));
    case "openTask":
      return openTask(context.paths, command.taskId);
    case "openSelectedTask":
      return openTask(context.paths, requireSelectedTaskId(context, "open"));
    case "runChecks":
      return runChecks(context.paths, command.taskId);
    case "runSelectedTaskChecks":
      return runChecks(context.paths, requireSelectedTaskId(context, "check"));
    case "commitTask":
      return commitTask(context.paths, command.taskId);
    case "commitSelectedTask":
      return commitTask(context.paths, requireSelectedTaskId(context, "commit"));
    case "openPullRequest":
      return openPullRequest(context.paths, command.taskId, { watch: command.watch });
    case "openSelectedTaskPullRequest":
      return openPullRequest(context.paths, requireSelectedTaskId(context, "pr"), { watch: command.watch });
    case "mergeTask":
      return mergeTask(context.paths, command.taskId, {
        preserveWorktree: command.preserveWorktree,
      });
    case "mergeSelectedTask":
      return mergeTask(context.paths, requireSelectedTaskId(context, "merge"), {
        preserveWorktree: command.preserveWorktree,
      });
    case "help":
      return { kind: "help", text: getHelpText() };
    case "exit":
      return { kind: "exit" };
    default:
      return assertNever(command);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unsupported command: ${JSON.stringify(value)}`);
}

function requireSelectedTaskId(context: CommandContext, commandName: string): string {
  if (context.selectedTaskId) {
    return context.selectedTaskId;
  }

  throw new Error(`No task selected. Create a task with 'task new --repo <repo-id> <prompt>' or use '${commandName} <id>'.`);
}
