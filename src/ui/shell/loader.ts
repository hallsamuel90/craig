import type { RunnerType } from "../../domain/config/index.js";
import { taskService } from "../../domain/task/index.js";
import { listWorkspaceRecords, workspaceService } from "../../domain/workspace/index.js";
import { getCraigPaths } from "../../state/craig-paths.js";
import type { TaskRecord } from "../../types/task.js";
import { loadTaskLocalInspection } from "../task-local-inspection.js";
import type { WorkspaceShellModel } from "./data.js";
import { restoreShellState } from "../state.js";
import type { ControlShellState } from "../state.js";

export async function loadWorkspaceShellModel(
  workspaceRoot: string,
  shell?: ControlShellState,
  enabledRunnerIds?: RunnerType[],
): Promise<WorkspaceShellModel> {
  const paths = getCraigPaths(workspaceRoot);
  const [repos, workspaces, taskResult] = await Promise.all([workspaceService.repos.listRegisteredRepos(paths).then((r) => r.repos), listWorkspaceRecords(paths), taskService.listTasks(paths)]);
  const selectedTask = resolveSelectedTaskForInspection(taskResult.tasks, shell);
  const selection = shell
    ? {
        selectedFilePath: shell.selectedFilePath,
        selectedDiffPath: shell.selectedDiffPath,
      }
    : {};
  const inspection = selectedTask ? await loadTaskLocalInspection(selectedTask, selection) : null;
  return {
    workspaceRoot,
    workspaces: workspaces.filter((workspace) => workspace.status === "active"),
    repos,
    tasks: taskResult.tasks,
    inspection,
    ...(enabledRunnerIds ? { enabledRunnerIds } : {}),
  };
}

export function resolveSelectedTaskForInspection(tasks: TaskRecord[], shell: ControlShellState | undefined): TaskRecord | null {
  if (!shell?.selectedTaskId) {
    return null;
  }

  return tasks.find((task) => task.id === shell.selectedTaskId) ?? null;
}

export function resolveShellState(state: ControlShellState, model: WorkspaceShellModel): ControlShellState {
  return restoreShellState(state, model);
}

export function getLeftItemIds(model: WorkspaceShellModel): string[] {
  const itemIds: string[] = [];

  if (model.workspaces?.length) {
    for (const workspace of model.workspaces) {
      itemIds.push(`workspace:${workspace.id}`);
      for (const task of model.tasks.filter((entry) => entry.workspaceId === workspace.id)) {
        itemIds.push(`task:${task.id}`);
      }
      if (workspace.kind === "project") {
        itemIds.push(`new-task-workspace:${workspace.id}`);
      }
      if (workspace.kind === "repo") {
        itemIds.push(`new-task:${workspace.primaryRepoId}`);
      }
    }
  } else {
    for (const repo of model.repos) {
      itemIds.push(`repo:${repo.id}`);
      for (const task of model.tasks.filter((entry) => entry.repoId === repo.id)) {
        itemIds.push(`task:${task.id}`);
      }
      itemIds.push(`new-task:${repo.id}`);
    }
  }

  itemIds.push("new-workspace");
  return itemIds;
}
