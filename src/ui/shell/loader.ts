import type { RunnerType } from "../../domain/config/index.js";
import { taskService } from "../../domain/task/index.js";
import { workspaceService } from "../../domain/workspace/index.js";
import { getCraigPaths } from "../../state/craig-paths.js";
import type { TaskRecord } from "../../domain/task/index.js";
import { loadTaskLocalInspection } from "./task-local-inspection.js";
import type { WorkspaceShellModel } from "./data.js";
import { restoreShellState, getLeftItemIds } from "../state.js";
import type { ControlShellState } from "../state.js";

export async function loadWorkspaceShellModel(
  workspaceRoot: string,
  shell?: ControlShellState,
  enabledRunnerIds?: RunnerType[],
): Promise<WorkspaceShellModel> {
  const paths = getCraigPaths(workspaceRoot);
  const [repoResult, workspaceResult] = await Promise.all([
    workspaceService.repos.listRegisteredRepos(paths),
    workspaceService.listWorkspaces(paths, { archived: false }),
  ]);
  const taskResult = await taskService.listTasks(paths);
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
    workspaces: workspaceResult.workspaces,
    repos: repoResult.repos,
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

export { getLeftItemIds };
