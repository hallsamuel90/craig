import type { TaskPtyTabRecord, TaskRecord } from "../../types/task.js";
import type { RunnerType } from "../../domain/config/index.js";
import {
  createPtyTab,
  closePtyTab,
  ensureAgentTab,
  markRunnerFailed as markRunnerFailedAction,
  closeTask as closeTaskAction,
  removeWorkspace as removeWorkspaceAction,
} from "../actions/index.js";
import { getViewport } from "../layout.js";
import { getPtySize } from "./session.js";
import { getSelectedTask } from "../shell/sync.js";
import { updateTerminalViewState, markTerminalAttachFailed, type ControlShellState } from "../state.js";
import { isAgentTabId } from "../input/keyboard.js";
import { syncShell, applyErrorToast, reportRecoverableError, reloadModel, buildActionContext, persistShellState } from "../shell/sync.js";
import type { AppContext } from "../app-context.js";

export async function hydrateOpenPtyTabs(ctx: AppContext): Promise<void> {
  const activeTabIds = ctx.model.tasks.flatMap((task) => task.ptyTabs.map((tab) => tab.id));
  await ctx.ptyRuntime.pruneStale?.(activeTabIds);
  await ctx.ptyRuntime.hydrateSessions?.(activeTabIds);
}

export function hydrateAndRenderOpenPtyTabs(ctx: AppContext): void {
  void hydrateOpenPtyTabs(ctx)
    .catch(() => undefined)
    .then(() => {
      if (ctx.state.mode !== "main") {
        return;
      }

      ctx.state = { mode: "main", shell: syncShell(ctx, ctx.state.shell) };
      ctx.render();
    });
}

export async function warmSelectedPtyTab(ctx: AppContext, shell: ControlShellState): Promise<ControlShellState> {
  const syncedShell = syncShell(ctx, shell);
  const selectedTask = getSelectedTask(ctx.model.tasks, syncedShell);
  const tabId = resolveTerminalViewTabId(ctx, syncedShell);

  if (!selectedTask || !tabId || !selectedTask.ptyTabs.some((tab) => tab.id === tabId)) {
    return syncedShell;
  }

  const hydratedView = ctx.ptyRuntime.getViewState(tabId);
  if (hydratedView.status !== "idle" || hydratedView.rows.length > 0 || hydratedView.error) {
    return updateTerminalViewState(syncedShell, hydratedView);
  }

  const view = await ctx.ptyRuntime.ensureSession(
    selectedTask.id,
    tabId,
    getPtySize(getViewport(ctx.activeTerminal.width, ctx.activeTerminal.height)),
  );

  return updateTerminalViewState({ ...syncedShell, inputMode: "control" }, view);
}

function resolveTerminalViewTabId(ctx: AppContext, shell: ControlShellState): string | null {
  const selectedTask = getSelectedTask(ctx.model.tasks, shell);
  if (!selectedTask) {
    return shell.selectedPtyTabId;
  }

  if (selectedTask.ptyTabs.some((tab) => tab.id === shell.activeTab)) {
    return shell.activeTab;
  }

  if (shell.activeTab === "agent" || shell.activeTab === "terminal") {
    return selectedTask.ptyTabs.find((tab) => tab.kind === shell.activeTab)?.id ?? shell.selectedPtyTabId;
  }

  return shell.selectedPtyTabId;
}

export function syncInputCapture(ctx: AppContext): void {
  const nextMode =
    ctx.state.mode === "main" && ctx.state.shell.inputMode === "terminal" ? "terminal" : "control";
  if (nextMode === ctx.inputCaptureMode) {
    return;
  }

  ctx.inputCaptureMode = nextMode;
  ctx.activeTerminal.grabInput(nextMode === "terminal" ? { mouse: "button" } : true);
}

export async function attachPtyFromShell(ctx: AppContext, shell: ControlShellState): Promise<void> {
  try {
    const syncedShell = syncShell(ctx, shell);
    let selectedTask = getSelectedTask(ctx.model.tasks, syncedShell);
    let tabId = syncedShell.selectedPtyTabId;

    if (selectedTask && syncedShell.focusedRegion === "tasks") {
      const agentTab = selectedTask.ptyTabs.find((tab) => tab.kind === "agent") ?? null;
      if (agentTab) {
        tabId = agentTab.id;
      } else {
        selectedTask = await ensureDefaultAgentTab(ctx, selectedTask);
        await reloadModel(ctx);
        tabId = selectedTask.selectedPtyTabId;
      }
    }

    if (selectedTask && !tabId) {
      selectedTask = await ensureDefaultAgentTab(ctx, selectedTask);
      await reloadModel(ctx);
      tabId = selectedTask.selectedPtyTabId;
    }

    const nextShell = syncShell(ctx, {
      ...syncedShell,
      activeTab: tabId ?? syncedShell.activeTab,
      selectedPtyTabId: tabId,
      focusedRegion: tabId ? "center" : syncedShell.focusedRegion,
    });

    if (!nextShell.selectedTaskId || !tabId) {
      ctx.state = { mode: "main", shell: nextShell };
      ctx.render();
      return;
    }

    ctx.state = {
      mode: "main",
      shell: updateTerminalViewState({ ...nextShell, inputMode: "terminal" }, ctx.ptyRuntime.getViewState(tabId)),
    };
    persistShellState(ctx, ctx.state.shell);
    const view = await ctx.ptyRuntime.ensureSession(
      nextShell.selectedTaskId,
      tabId,
      getPtySize(getViewport(ctx.activeTerminal.width, ctx.activeTerminal.height)),
    );
    ctx.suppressTerminalEnterOnAttach = isAgentTabId(tabId);
    ctx.lastTerminalKey = null;
    ctx.state = { mode: "main", shell: updateTerminalViewState({ ...nextShell, inputMode: "terminal" }, view) };
    persistShellState(ctx, ctx.state.shell);
  } catch (error) {
    const message = reportRecoverableError(ctx, "attach PTY", error, "Failed to start PTY.");
    if (shell.selectedTaskId && shell.selectedPtyTabId && isAgentTabId(shell.selectedPtyTabId)) {
      await markTaskRunnerFailed(ctx, shell.selectedTaskId, message).catch(() => undefined);
      await reloadModel(ctx).catch(() => undefined);
    }
    ctx.state = {
      mode: "main",
      shell: applyErrorToast(ctx, markTerminalAttachFailed(syncShell(ctx, shell), message), message),
    };
    persistShellState(ctx, ctx.state.shell);
  }
  ctx.render();
}

export async function markTaskRunnerFailed(ctx: AppContext, taskId: string, message: string): Promise<void> {
  await markRunnerFailedAction(taskId, message, buildActionContext(ctx));
}

export async function createPtyTabFromShell(
  ctx: AppContext,
  shell: ControlShellState,
  requestedKind: TaskPtyTabRecord["kind"] | null,
  requestedRunner?: RunnerType | null,
): Promise<ControlShellState> {
  const syncedShell = syncShell(ctx, shell);
  const { nextShell } = await createPtyTab(syncedShell, requestedKind, requestedRunner, buildActionContext(ctx));
  await reloadModel(ctx);
  return syncShell(ctx, { ...syncedShell, ...nextShell });
}

export async function closePtyTabFromShell(ctx: AppContext, shell: ControlShellState): Promise<ControlShellState> {
  const syncedShell = syncShell(ctx, shell);
  const { closedTab, nextShell } = await closePtyTab(syncedShell, buildActionContext(ctx));
  ctx.ptyRuntime.disposeSession(closedTab.id);
  await reloadModel(ctx);
  return syncShell(ctx, { ...syncedShell, ...nextShell });
}

export async function closeTaskFromShell(ctx: AppContext, shell: ControlShellState): Promise<ControlShellState> {
  const syncedShell = syncShell(ctx, shell);
  const { closedTabIds, nextShell } = await closeTaskAction(syncedShell, buildActionContext(ctx));
  for (const tabId of closedTabIds) {
    ctx.ptyRuntime.disposeSession(tabId);
  }
  await reloadModel(ctx);
  return syncShell(ctx, { ...syncedShell, ...nextShell });
}

export async function removeWorkspaceFromShell(ctx: AppContext, shell: ControlShellState): Promise<ControlShellState> {
  const syncedShell = syncShell(ctx, shell);
  const { nextShell } = await removeWorkspaceAction(syncedShell, buildActionContext(ctx));
  await reloadModel(ctx);
  return syncShell(ctx, { ...syncedShell, ...nextShell });
}

export async function ensureDefaultAgentTab(ctx: AppContext, task: TaskRecord): Promise<TaskRecord> {
  return ensureAgentTab(task, buildActionContext(ctx));
}
