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
  const blockers = taskResult.tasks.filter((task) => task.status !== "closed");
  if (blockers.length > 0) {
    throw new Error(
      `Close tasks before removing workspace: ${blockers.map((task) => `${task.id} (${task.status})`).join(", ")}.`,
    );
  }

  await ctx.workspaceService.archiveWorkspace(ctx.paths, shell.selectedWorkspaceId);
  const hasHistory = taskResult.tasks.length > 0;
  if (!hasHistory) {
    await ctx.workspaceService.removeWorkspace(ctx.paths, shell.selectedWorkspaceId, {
      listTasks: ctx.taskService.listTasks,
    });
  }

  return {
    nextShell: {
      selectedWorkspaceId: null,
      selectedRepoId: null,
      selectedTaskId: null,
      selectedPtyTabId: null,
      selectedLeftItemId: null,
      actionMessage: hasHistory
        ? `Archived workspace ${shell.selectedWorkspaceId}; closed task history preserved.`
        : `Removed workspace ${shell.selectedWorkspaceId}`,
    },
  };
};
