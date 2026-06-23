import type { CommandResult, AppCommand } from "../types/command.js";
import type { CraigPaths } from "../state/craig-paths.js";
import { getHelpText } from "./parse-argv.js";
import { taskService } from "../domain/task/index.js";
import { workspaceService } from "../domain/workspace/index.js";

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
      return workspaceService.addWorkspace(context.paths, command.path);
    case "addRepo":
      return workspaceService.repos.addRepo(context.paths, command.path);
    case "listRepos":
      return workspaceService.repos.listRegisteredRepos(context.paths);
    case "removeRepo":
      return workspaceService.repos.removeRepo(context.paths, command.repoId);
    case "listWorkspaces":
      return workspaceService.listWorkspaces(context.paths, { archived: command.archived });
    case "archiveWorkspace":
      return workspaceService.archiveWorkspace(context.paths, command.workspaceId);
    case "restoreWorkspace":
      return workspaceService.restoreWorkspace(context.paths, command.workspaceId);
    case "removeWorkspace":
      return workspaceService.removeWorkspace(context.paths, command.workspaceId);
    case "createTask":
      return taskService.createTask(
        context.paths,
        command.repoId ?? command.workspaceId ?? "",
        command.prompt,
        { ...(command.runner ? { runner: command.runner } : {}), ...(command.workspaceId ? { workspaceId: command.workspaceId } : {}) },
      );
    case "listTasks":
      return command.repoId || command.workspaceId
        ? taskService.listTasks(context.paths, { ...(command.repoId ? { repoId: command.repoId } : {}), ...(command.workspaceId ? { workspaceId: command.workspaceId } : {}) })
        : taskService.listTasks(context.paths);
    case "attachTask":
      return taskService.attachTask(context.paths, command.taskId);
    case "addTaskLink":
      return taskService.addTaskLink(context.paths, command.taskId, command.repoId);
    case "listTaskLinks":
      return taskService.listTaskLinks(context.paths, command.taskId);
    case "refreshInteractiveState":
      throw new Error("Interactive refresh should be handled by the interactive app.");
    case "showTask":
      return taskService.showTask(context.paths, command.taskId);
    case "showSelectedTask":
      return taskService.showTask(context.paths, requireSelectedTaskId(context, "show"));
    case "streamTaskLogs":
      return taskService.prepareTaskLogs(context.paths, command.taskId);
    case "streamSelectedTaskLogs":
      return taskService.prepareTaskLogs(context.paths, requireSelectedTaskId(context, "logs"));
    case "showTaskDiff":
      return taskService.showTaskDiff(context.paths, command.taskId);
    case "showSelectedTaskDiff":
      return taskService.showTaskDiff(context.paths, requireSelectedTaskId(context, "diff"));
    case "focusTask":
      return taskService.focusTask(context.paths, command.taskId);
    case "focusSelectedTask":
      return taskService.focusTask(context.paths, requireSelectedTaskId(context, "focus"));
    case "openTask":
      return taskService.openTask(context.paths, command.taskId);
    case "openSelectedTask":
      return taskService.openTask(context.paths, requireSelectedTaskId(context, "open"));
    case "runChecks":
      return taskService.runChecks(context.paths, command.taskId);
    case "runSelectedTaskChecks":
      return taskService.runChecks(context.paths, requireSelectedTaskId(context, "check"));
    case "commitTask":
      return taskService.commitTask(context.paths, command.taskId);
    case "commitSelectedTask":
      return taskService.commitTask(context.paths, requireSelectedTaskId(context, "commit"));
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
