import { getCraigPaths } from "../state/craig-paths.js";
import { CraigError } from "../domain/error/index.js";
import { taskService, type ResolvedTaskContext } from "../domain/task/index.js";
import { workspaceService, type ResolvedWorkspaceContext } from "../domain/workspace/index.js";

export interface ResolveCliContextInput {
  cwd: string;
  explicitWorkspaceRoot?: string;
  environmentWorkspaceRoot?: string;
  explicitTaskId?: string;
  environmentTaskId?: string;
  environmentAgentTabId?: string;
  allowUninitializedWorkspace?: boolean;
  resolveTask?: boolean;
  requireTask?: boolean;
}

export interface ResolvedCliContext {
  paths: ReturnType<typeof getCraigPaths>;
  workspace: ResolvedWorkspaceContext;
  task: ResolvedTaskContext | null;
}

export async function resolveCliContext(input: ResolveCliContextInput): Promise<ResolvedCliContext> {
  const workspace = await workspaceService.resolveContext({
    cwd: input.cwd,
    ...(input.explicitWorkspaceRoot !== undefined
      ? { explicitWorkspaceRoot: input.explicitWorkspaceRoot }
      : {}),
    ...(input.environmentWorkspaceRoot !== undefined
      ? { environmentWorkspaceRoot: input.environmentWorkspaceRoot }
      : {}),
    ...(input.allowUninitializedWorkspace !== undefined
      ? { allowUninitializedCwd: input.allowUninitializedWorkspace }
      : {}),
  });
  const paths = getCraigPaths(workspace.workspaceRoot);
  const shouldResolveTask =
    input.resolveTask === true ||
    input.requireTask === true ||
    input.explicitTaskId !== undefined ||
    input.environmentTaskId !== undefined ||
    input.environmentAgentTabId !== undefined;
  if (shouldResolveTask && !workspace.initialized) {
    throw new CraigError(
      "TASK_CONTEXT_NOT_FOUND",
      `Task context cannot be resolved because ${workspace.workspaceRoot} is not an initialized Craig workspace.`,
      { details: { workspaceRoot: workspace.workspaceRoot } },
    );
  }
  const task = shouldResolveTask && workspace.initialized
    ? await taskService.resolveContext(paths, {
        cwd: input.cwd,
        ...(input.explicitTaskId !== undefined ? { explicitTaskId: input.explicitTaskId } : {}),
        ...(input.environmentTaskId !== undefined ? { environmentTaskId: input.environmentTaskId } : {}),
        ...(input.environmentAgentTabId !== undefined
          ? { environmentAgentTabId: input.environmentAgentTabId }
          : {}),
        ...(input.requireTask !== undefined ? { required: input.requireTask } : {}),
      })
    : null;

  return { paths, workspace, task };
}
