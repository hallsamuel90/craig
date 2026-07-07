import { taskService } from "../../domain/task/index.js";
import { getTaskPrimaryPr } from "../../domain/task/index.js";
import { loadWorkspaceShellModel } from "../shell/loader.js";
import {
  pollPullRequests as pollPullRequestsAction,
  logBackgroundError,
} from "../actions/index.js";
import { syncShell, setSuccessToast, buildActionContext, reloadModel } from "../shell/sync.js";
import { getSelectedTask } from "../shell/sync.js";
import type { ControlShellState } from "../state.js";
import type { AppContext } from "../app-context.js";

export async function pollPullRequests(ctx: AppContext): Promise<void> {
  if (ctx.prPollInFlight || ctx.state.mode !== "main") {
    return;
  }

  ctx.prPollInFlight = true;
  try {
    await pollPullRequestsAction(ctx.model.tasks, buildActionContext(ctx));
    ctx.lastBackgroundPrPollError = null;
    if (ctx.state.mode !== "main") return;
    ctx.model = await loadWorkspaceShellModel(ctx.workspaceRoot, ctx.state.shell, ctx.enabledRunnerIds);
    ctx.state = { mode: "main", shell: syncShell(ctx, ctx.state.shell) };
    ctx.render();
  } catch (error) {
    const message = error instanceof Error ? error.message : "Background PR discovery failed.";
    if (message !== ctx.lastBackgroundPrPollError) {
      ctx.lastBackgroundPrPollError = message;
      void logBackgroundError("background PR polling", error, buildActionContext(ctx));
    }
  } finally {
    ctx.prPollInFlight = false;
  }
}

export async function refreshPullRequestChecksFromShell(ctx: AppContext, shell: ControlShellState): Promise<ControlShellState> {
  const syncedShell = syncShell(ctx, shell);
  const selectedTask = getSelectedTask(ctx.model.tasks, syncedShell);
  let actionMessage: string | null = null;
  let footerToast: string | null = null;

  if (selectedTask?.type === "project" && selectedTask.repoTargets?.length) {
    const counts = await taskService.prs.discoverOrRefreshAll(ctx.paths, syncedShell.selectedTaskId!);
    await reloadModel(ctx);
    const total = counts.synced + counts.discovered + counts.notFound;
    footerToast = `Refreshed ${counts.synced}/${total} targets`;
  } else {
    const { disposition, task } = await taskService.prs.discoverOrRefresh(ctx.paths, syncedShell.selectedTaskId!);
    await reloadModel(ctx);
    actionMessage = disposition === "not_found" ? `No PR found for ${task.branch}` : null;
    if (disposition !== "not_found") {
      footerToast = `Refreshed checks: ${getTaskPrimaryPr(task)?.requiredChecks.length ?? 0} reported`;
    }
  }

  return syncShell(ctx, {
    ...setSuccessToast(ctx, syncedShell, footerToast),
    focusedRegion: "inspector",
    inspectionMode: "review",
    selectedActionId: "refresh-checks",
    actionMessage,
  });
}
