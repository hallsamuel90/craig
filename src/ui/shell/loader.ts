import type { RunnerType } from "../../domain/config/index.js";
import { taskService } from "../../domain/task/index.js";
import { workspaceService } from "../../domain/workspace/index.js";
import { getCraigPaths } from "../../state/craig-paths.js";
import type { TaskRecord } from "../../domain/task/index.js";
import { loadTaskLocalInspection } from "./task-local-inspection.js";
import type { WorkspaceShellModel } from "./data.js";
import { restoreShellState, getLeftItemIds } from "../state.js";
import type { ControlShellState } from "../state.js";
import { configService } from "../../domain/config/index.js";
import { ensureTaskCapabilities, listFuryReviews, listPendingFuryPlans } from "../../domain/orchestration/index.js";

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
  let taskResult = await taskService.listTasks(paths);
  const agentCapabilityTokens: Record<string, string> = {};
  const config = await configService.load(paths);
  let furyApprovalCount = 0;
  if (configService.previews.isEnabled(config, "agentOrchestration")) {
    const environments = await Promise.all(taskResult.tasks.flatMap((task) =>
      task.ptyTabs.filter((tab) => tab.kind === "agent").map(async (agentTab) => ({
        agentTab,
        environment: await ensureTaskCapabilities(paths, task, undefined, agentTab.id),
      }))));
    for (const { agentTab, environment } of environments) {
      if (environment.CRAIG_AGENT_CAPABILITY) {
        agentCapabilityTokens[agentTab.id] = environment.CRAIG_AGENT_CAPABILITY;
      }
    }
    taskResult = await taskService.listTasks(paths);
    const [pendingPlans, reviews] = await Promise.all([listPendingFuryPlans(paths), listFuryReviews(paths)]);
    furyApprovalCount = pendingPlans.length + reviews.filter((review) => review.state === "waiting_for_review").length;
  }
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
    furyApprovalCount,
    ...(Object.keys(agentCapabilityTokens).length > 0 ? { agentCapabilityTokens } : {}),
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
