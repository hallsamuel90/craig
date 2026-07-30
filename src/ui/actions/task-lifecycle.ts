import { readTask } from "../../domain/task/index.js";
import { errorService } from "../../domain/error/index.js";
import { configService } from "../../domain/config/index.js";
import type { RunnerType } from "../../domain/config/index.js";
import { requireExecutablePath, withDefaultCommandPath } from "../../shared/command-path.js";
import type { TaskRecord } from "../../domain/task/index.js";
import type { ControlShellState } from "../state.js";
import type { ActionContext } from "./context.js";

export class InteractiveTaskStartupError extends Error {
  readonly task: TaskRecord;

  constructor(message: string, task: TaskRecord) {
    super(message);
    this.name = "InteractiveTaskStartupError";
    this.task = task;
  }
}

export const createInteractiveTask = async (
  repoId: string | null,
  workspaceId: string | null,
  prompt: string,
  runner: RunnerType,
  ctx: ActionContext,
): Promise<{ task: TaskRecord; nextShell: Partial<ControlShellState> }> => {
  configService.runners.assertEnabled(runner, ctx.config);
  const provisioned = workspaceId
    ? await ctx.taskService.provisionProjectTask(ctx.paths, workspaceId, prompt, { runner, config: ctx.config })
    : await ctx.taskService.provisionTask(ctx.paths, repoId ?? "", prompt, { runner, config: ctx.config });
  try {
    const env = withDefaultCommandPath();
    requireExecutablePath(configService.runners.getConfiguredProfile(runner, ctx.config).executable, {
      cwd: provisioned.repoRoot,
      env,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to start runner.";
    const failedTask = await ctx.taskService.recordStartupFailure(ctx.paths, provisioned.task.id, message);
    throw new InteractiveTaskStartupError(message, failedTask);
  }
  const task = await ctx.taskService.markTaskStarted(ctx.paths, provisioned.task.id);
  const nextShell: Partial<ControlShellState> = {
    selectedRepoId: task.repoId,
    selectedWorkspaceId: task.workspaceId,
    selectedTaskId: task.id,
    selectedPtyTabId: task.selectedPtyTabId,
    inputMode: "control",
    focusedRegion: "center",
    activeTab: task.selectedPtyTabId ?? "agent",
    selectedActionId: "commit",
  };
  return { task, nextShell };
};

export const markRunnerFailed = async (
  taskId: string,
  message: string,
  ctx: ActionContext,
): Promise<void> => {
  await ctx.queueTaskMutation(async () => {
    await ctx.taskService.markRunnerFailed(ctx.paths, taskId, message);
  });
};

export const closeTask = async (
  shell: ControlShellState,
  ctx: ActionContext,
): Promise<{ nextShell: Partial<ControlShellState>; closedTabIds: string[] }> => {
  if (!shell.selectedTaskId) {
    throw new Error("Select a task before closing it.");
  }

  const { taskBeforeClose, task } = await ctx.queueTaskMutation(async () => {
    const taskBeforeClose = await readTask(ctx.paths, shell.selectedTaskId!);
    const task = await ctx.taskService.closeTask(ctx.paths, shell.selectedTaskId!);
    return { taskBeforeClose, task };
  });

  return {
    closedTabIds: taskBeforeClose.ptyTabs.map((tab) => tab.id),
    nextShell: {
      selectedActionId: "close-task",
      actionMessage: task.cleanup.preservedWorktree
        ? `Archived task ${task.id}; worktree preserved`
        : `Archived task ${task.id}`,
    },
  };
};

export const pollPullRequests = async (
  tasks: TaskRecord[],
  ctx: ActionContext,
): Promise<void> => {
  await ctx.taskService.prs.discoverOrRefreshMany(ctx.paths, tasks);
};

export const logBackgroundError = async (
  context: string,
  error: unknown,
  ctx: ActionContext,
): Promise<void> => {
  const message = error instanceof Error ? error.message : String(error);
  await errorService.appendErrorLogBestEffort(ctx.paths, {
    context,
    message,
    details: error instanceof Error ? (error.stack ?? error.message) : String(error),
  });
};
