import { writeUiState } from "../state/ui-state-store.js";
import { errorService } from "../domain/error/index.js";
import { taskService } from "../domain/task/index.js";
import { workspaceService } from "../domain/workspace/index.js";
import { reloadSelectedContent } from "./task-local-inspection.js";
import { loadWorkspaceShellModel, resolveShellState, resolveSelectedTaskForInspection, getVisibleFileTreeRows, getLeftItemIds } from "./model-loader.js";
import { getViewport, SHELL_LAYOUT } from "./layout.js";
import { buildShellData, getReviewInspectionRowCount } from "./shell-data.js";
import { loadWorkspaceBrowser } from "./workspace-browser.js";
import { getSelectedTask } from "./shell-state.js";
import { scrollInspectionContent, toPersistedUiState, updateTerminalViewState, buildCenterTabIds, type ControlShellState, type FooterToast } from "./state.js";
import type { ActionContext } from "./actions/index.js";
import { persistPtyTabSelection } from "./actions/index.js";
import type { AppContext } from "./app-context.js";

export function withTerminalView(ctx: AppContext, shell: ControlShellState): ControlShellState {
  return updateTerminalViewState(shell, ctx.ptyRuntime.getViewState(resolveTerminalViewTabId(ctx, shell)));
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

export function syncShell(ctx: AppContext, shell: ControlShellState): ControlShellState {
  return withTerminalView(ctx, resolveShellState(shell, ctx.model));
}

export function setFooterToast(ctx: AppContext, shell: ControlShellState, footerToast: FooterToast | null): ControlShellState {
  if (ctx.footerToastTimer) {
    clearTimeout(ctx.footerToastTimer);
    ctx.footerToastTimer = null;
  }
  if (!footerToast) {
    return { ...shell, footerToast: null };
  }

  ctx.footerToastTimer = setTimeout(() => {
    ctx.footerToastTimer = null;
    if (ctx.state.mode !== "main" || ctx.state.shell.footerToast !== footerToast) {
      return;
    }
    ctx.state = { mode: "main", shell: syncShell(ctx, { ...ctx.state.shell, footerToast: null }) };
    ctx.render();
  }, 600);

  return { ...shell, footerToast };
}

export function setSuccessToast(ctx: AppContext, shell: ControlShellState, message: string | null): ControlShellState {
  return setFooterToast(ctx, shell, message ? { tone: "success", message } : null);
}

export function applyErrorToast(ctx: AppContext, shell: ControlShellState, message: string): ControlShellState {
  return setFooterToast(ctx, shell, { tone: "error", message });
}

export function reportRecoverableError(ctx: AppContext, context: string, error: unknown, fallbackMessage: string): string {
  const message = error instanceof Error ? error.message : fallbackMessage;
  const details = error instanceof Error ? error.stack ?? error.message : String(error);
  void errorService.appendErrorLogBestEffort(ctx.paths, { context, message, details });
  return message;
}

export function persistShellState(ctx: AppContext, shell: ControlShellState): void {
  if (!ctx.uiStateFile) {
    return;
  }

  ctx.runtimeState = toPersistedUiState(ctx.runtimeState, shell);
  const nextRuntimeState = ctx.runtimeState;
  ctx.persistQueue = ctx.persistQueue.then(
    () => writeUiState({ uiStateFile: ctx.uiStateFile! }, nextRuntimeState),
    () => writeUiState({ uiStateFile: ctx.uiStateFile! }, nextRuntimeState),
  );
  void ctx.persistQueue.catch(() => undefined);
}

export function queueTaskMutation<T>(ctx: AppContext, mutation: () => Promise<T>): Promise<T> {
  const next = ctx.taskMutationQueue.then(mutation, mutation);
  ctx.taskMutationQueue = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

export function buildActionContext(ctx: AppContext): ActionContext {
  return {
    paths: ctx.paths,
    config: ctx.config,
    taskService,
    workspaceService,
    queueTaskMutation: (fn) => queueTaskMutation(ctx, fn),
  };
}

export function getShellKeyOptions(ctx: AppContext, shell: ControlShellState) {
  const selectedTask = getSelectedTask(ctx.model.tasks, shell);
  const inspection = ctx.model.inspection;
  const selectedInspection = inspection && inspection.taskId === selectedTask?.id ? inspection : null;
  const fileTreeRows = getVisibleFileTreeRows(selectedInspection?.fileRows ?? [], shell.collapsedFileTreePaths);
  return {
    leftItemIds: getLeftItemIds(ctx.model),
    centerTabIds: buildCenterTabIds(selectedTask, shell),
    ptyTabIds: selectedTask?.ptyTabs.map((tab) => tab.id) ?? [],
    filePathIds: selectedInspection?.filePaths ?? [],
    fileTreeRowIds: fileTreeRows.map((row) => row.path),
    fileTreeFileIds: fileTreeRows.filter((row) => row.kind === "file").map((row) => row.path),
    fileTreeDirectoryIds: fileTreeRows.filter((row) => row.kind === "directory").map((row) => row.path),
    diffPathIds: selectedInspection?.diffPaths ?? [],
    diffPathRanges: [],
    fileLineCount: selectedInspection?.selectedFile.lines.length ?? 0,
    diffLineCount: selectedInspection?.selectedDiff.lines.length ?? 0,
    reviewRowCount: getReviewInspectionRowCount(shell, selectedTask),
    pageRows: Math.max(5, getViewport(ctx.activeTerminal.width, ctx.activeTerminal.height).height - SHELL_LAYOUT.topRailHeight - 9),
    enabledRunnerIds: ctx.enabledRunnerIds,
    projectTargetIds: selectedTask?.repoTargets?.map((t) => t.repoId) ?? [],
  };
}

export async function persistTaskPtySelection(ctx: AppContext, shell: ControlShellState): Promise<void> {
  await persistPtyTabSelection(shell, buildActionContext(ctx));
}

export async function reloadModel(ctx: AppContext): Promise<void> {
  ctx.model = await loadWorkspaceShellModel(ctx.workspaceRoot, ctx.state.shell, ctx.enabledRunnerIds);
  if (ctx.state.mode === "main") {
    ctx.state = { mode: "main", shell: syncShell(ctx, ctx.state.shell) };
  } else {
    ctx.state = { ...ctx.state, shell: syncShell(ctx, ctx.state.shell) };
  }
}

export async function refreshInspection(ctx: AppContext, shell: ControlShellState): Promise<void> {
  const refreshId = ++ctx.inspectionRefreshSequence;
  const selectedTask = resolveSelectedTaskForInspection(ctx.model.tasks, shell);
  const prevInspection = ctx.model.inspection;

  let nextModel;
  if (selectedTask && prevInspection?.taskId === selectedTask.id) {
    const selection = { selectedFilePath: shell.selectedFilePath, selectedDiffPath: shell.selectedDiffPath };
    const nextInspection = await reloadSelectedContent(selectedTask, prevInspection, selection);
    if (refreshId !== ctx.inspectionRefreshSequence) {
      return;
    }
    nextModel = { ...ctx.model, inspection: nextInspection };
  } else {
    nextModel = await loadWorkspaceShellModel(ctx.workspaceRoot, shell, ctx.enabledRunnerIds);
    if (refreshId !== ctx.inspectionRefreshSequence) {
      return;
    }
  }

  ctx.model = nextModel;
  if (ctx.state.mode === "main") {
    ctx.state = { mode: "main", shell: syncShell(ctx, ctx.state.shell) };
    persistShellState(ctx, ctx.state.shell);
    ctx.render();
  }
}

export async function openWorkspaceBrowser(ctx: AppContext, rootPath: string): Promise<void> {
  const browser = await loadWorkspaceBrowser(rootPath);
  if (ctx.state.mode !== "main") {
    return;
  }

  ctx.state = {
    mode: "main",
    shell: syncShell(ctx, {
      ...ctx.state.shell,
      workspaceBrowser: browser,
      activeTab: ctx.state.shell.selectedPtyTabId ?? ctx.state.shell.activeTab,
      actionMessage: null,
    }),
  };
  ctx.render();
}

export function scheduleTerminalViewportScroll(ctx: AppContext, lines: number): void {
  ctx.pendingScrollLines += lines;

  if (ctx.scrollRenderTimer) {
    return;
  }

  ctx.scrollRenderTimer = setTimeout(() => {
    ctx.scrollRenderTimer = null;
    const linesToScroll = ctx.pendingScrollLines;
    ctx.pendingScrollLines = 0;

    if (linesToScroll === 0) {
      return;
    }

    ctx.ptyRuntime.scrollViewport(linesToScroll);
    ctx.state = { mode: "main", shell: withTerminalView(ctx, (ctx.state as { mode: "main"; shell: ControlShellState }).shell) };
    ctx.render();
  }, 16);
}

export function scheduleInspectionViewportScroll(ctx: AppContext, lines: number): void {
  if (lines === 0) {
    return;
  }

  ctx.pendingInspectionScrollLines += lines;

  if (ctx.inspectionScrollRenderTimer) {
    return;
  }

  ctx.inspectionScrollRenderTimer = setTimeout(() => {
    ctx.inspectionScrollRenderTimer = null;
    const linesToScroll = ctx.pendingInspectionScrollLines;
    ctx.pendingInspectionScrollLines = 0;

    if (linesToScroll === 0 || ctx.state.mode !== "main" || ctx.state.shell.inputMode !== "control") {
      return;
    }

    const result = scrollInspectionContent(ctx.state.shell, linesToScroll, getShellKeyOptions(ctx, ctx.state.shell));
    if (!result.changed) {
      return;
    }

    if (result.refreshInspection) {
      ctx.state = { mode: "main", shell: syncShell(ctx, result.state) };
      persistShellState(ctx, ctx.state.shell);
      ctx.render();
      void refreshInspection(ctx, ctx.state.shell).catch((error: unknown) => {
        const message = reportRecoverableError(ctx, "refresh inspection", error, "Failed to refresh inspection.");
        ctx.state = { mode: "main", shell: applyErrorToast(ctx, syncShell(ctx, { ...ctx.state.shell, actionMessage: message }), message) };
        ctx.render();
      });
      return;
    }

    ctx.state = { mode: "main", shell: syncShell(ctx, result.state) };
    persistShellState(ctx, ctx.state.shell);
    ctx.render();
  }, 16);
}

export function restoreTerminalScreen(ctx: AppContext): void {
  ctx.pendingClear = true;
  ctx.activeTerminal.fullscreen(true);
}

// Re-export buildShellData for use by app.ts render function
export { buildShellData };
