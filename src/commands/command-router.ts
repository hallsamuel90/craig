import type { CommandResult, AppCommand } from "./types.js";
import type { CraigPaths } from "../state/craig-paths.js";
import type { ResolvedTaskContext } from "../domain/task/index.js";
import type { ResolvedWorkspaceContext } from "../domain/workspace/index.js";
import { getDefaultUiState, readUiState, writeUiState } from "../state/ui-state-store.js";
import { getHelpText } from "./parse-argv.js";
import { taskService } from "../domain/task/index.js";
import { listWorkspaceRecords, workspaceService } from "../domain/workspace/index.js";

export interface CommandContext {
  paths: CraigPaths;
  selectedTaskId?: string | null;
  workspaceContext?: ResolvedWorkspaceContext;
  taskContext?: ResolvedTaskContext | null;
}

export async function executeCommand(
  command: AppCommand,
  context: CommandContext,
): Promise<CommandResult> {
  switch (command.kind) {
    case "addWorkspace": {
      const result = await workspaceService.addWorkspace(context.paths, command.path);
      const selectedRepoId = result.workspace.kind === "project"
        ? (result.workspace.discoveredRepoIds?.[0] ?? null)
        : result.repos[0]?.id ?? null;
      await selectWorkspaceInUi(context.paths, result.workspace.id, selectedRepoId);
      return result;
    }
    case "addRepo": {
      const result = await workspaceService.repos.addRepo(context.paths, command.path);
      await selectWorkspaceInUi(context.paths, result.workspaceId, result.repo.id);
      return result;
    }
    case "listRepos":
      return workspaceService.repos.listRegisteredRepos(context.paths);
    case "removeRepo": {
      const ui = await readUiState({ uiStateFile: context.paths.uiStateFile });
      const affectedWorkspaceIds = ui?.selectedWorkspaceId
        ? (await listWorkspaceRecords(context.paths))
            .filter((w) => w.primaryRepoId === command.repoId)
            .map((w) => w.id)
        : [];
      const result = await workspaceService.repos.removeRepo(context.paths, command.repoId, { listTasks: taskService.listTasks });
      if (ui) {
        const workspaceCleared = affectedWorkspaceIds.includes(ui.selectedWorkspaceId ?? "");
        const repoCleared = ui.selectedRepoId === command.repoId;
        if (workspaceCleared) {
          await writeUiState({ uiStateFile: context.paths.uiStateFile }, { ...ui, selectedRepoId: null, selectedWorkspaceId: null, selectedTaskId: null });
        } else if (repoCleared) {
          await writeUiState({ uiStateFile: context.paths.uiStateFile }, { ...ui, selectedRepoId: null });
        }
      }
      return result;
    }
    case "listWorkspaces":
      return workspaceService.listWorkspaces(context.paths, { archived: command.archived });
    case "archiveWorkspace": {
      const result = await workspaceService.archiveWorkspace(context.paths, command.workspaceId);
      await clearWorkspaceInUi(context.paths, command.workspaceId);
      return result;
    }
    case "restoreWorkspace": {
      const result = await workspaceService.restoreWorkspace(context.paths, command.workspaceId);
      await selectWorkspaceInUi(context.paths, command.workspaceId, result.primaryRepoId);
      return result;
    }
    case "removeWorkspace":
      return workspaceService.removeWorkspace(context.paths, command.workspaceId, { listTasks: taskService.listTasks });
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
    case "currentTask": {
      const taskContext = requireResolvedTaskContext(context);
      return {
        kind: "currentTask",
        task: taskContext.task,
        context: {
          source: taskContext.source,
          agentTabId: taskContext.agentTabId,
        },
      };
    }
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
    case "showCurrentTask":
      return taskService.showTask(context.paths, requireResolvedTaskContext(context).task.id);
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
    case "showContext": {
      const workspace = requireWorkspaceContext(context);
      return {
        kind: "showContext",
        workspace: {
          root: workspace.workspaceRoot,
          source: workspace.source,
          initialized: workspace.initialized,
        },
        task: context.taskContext
          ? {
              id: context.taskContext.task.id,
              source: context.taskContext.source,
              agentTabId: context.taskContext.agentTabId,
            }
          : null,
      };
    }
    case "help":
      return { kind: "help", text: getHelpText() };
    case "exit":
      return { kind: "exit" };
    default:
      return assertNever(command);
  }
}

async function selectWorkspaceInUi(paths: CraigPaths, workspaceId: string, selectedRepoId: string | null): Promise<void> {
  const ui = (await readUiState({ uiStateFile: paths.uiStateFile })) ?? getDefaultUiState();
  await writeUiState({ uiStateFile: paths.uiStateFile }, { ...ui, selectedWorkspaceId: workspaceId, selectedRepoId, selectedTaskId: null });
}

async function clearWorkspaceInUi(paths: CraigPaths, workspaceId: string): Promise<void> {
  const ui = await readUiState({ uiStateFile: paths.uiStateFile });
  if (ui?.selectedWorkspaceId === workspaceId) {
    await writeUiState({ uiStateFile: paths.uiStateFile }, { ...ui, selectedWorkspaceId: null, selectedRepoId: null, selectedTaskId: null });
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

function requireResolvedTaskContext(context: CommandContext): ResolvedTaskContext {
  if (context.taskContext) {
    return context.taskContext;
  }

  throw new Error("Command requires resolved task context.");
}

function requireWorkspaceContext(context: CommandContext): ResolvedWorkspaceContext {
  if (context.workspaceContext) {
    return context.workspaceContext;
  }

  throw new Error("Command requires resolved workspace context.");
}
