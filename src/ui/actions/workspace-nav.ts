import type { ControlShellState } from "../state.js";
import type { ActionContext } from "./context.js";

export const removeWorkspace = async (
  shell: ControlShellState,
  ctx: ActionContext,
): Promise<{ nextShell: Partial<ControlShellState> }> => {
  if (!shell.selectedWorkspaceId) {
    throw new Error("Select a workspace before removing it.");
  }

  const taskResult = await ctx.taskService.listTasks(ctx.paths, {
    workspaceId: shell.selectedWorkspaceId,
    includeClosed: true,
  });
  if (taskResult.tasks.length > 0) {
    throw new Error(
      `Cannot remove workspace ${shell.selectedWorkspaceId} while task records still reference it.`,
    );
  }

  await ctx.workspaceService.archiveWorkspace(ctx.paths, shell.selectedWorkspaceId);
  const removed = await ctx.workspaceService.removeWorkspace(ctx.paths, shell.selectedWorkspaceId, {
    listTasks: ctx.taskService.listTasks,
  });

  return {
    nextShell: {
      selectedWorkspaceId: null,
      selectedRepoId: null,
      selectedTaskId: null,
      selectedPtyTabId: null,
      selectedLeftItemId: null,
      actionMessage: `Removed workspace ${removed.workspaceId}`,
    },
  };
};
