import { readTask } from "../../domain/task/index.js";
import { errorService } from "../../domain/error/index.js";
import type { TaskRecord } from "../../types/task.js";
import type { ControlShellState } from "../state.js";
import type { ActionContext } from "./context.js";

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
