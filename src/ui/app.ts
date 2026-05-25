import { createRequire } from "node:module";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import type * as TerminalKitModule from "terminal-kit";

import { listRepos } from "../state/repo-store.js";
import { getDefaultUiState, readUiState, writeUiState } from "../state/ui-state-store.js";
import { readCraigConfig, writeCraigConfig } from "../state/config-store.js";
import type { CraigConfig } from "../types/config.js";
import { readTask, writeTask } from "../state/task-store.js";
import { getCraigPaths } from "../state/craig-paths.js";
import { ensureCraigState } from "../state/ensure-state.js";
import type { RunnerType, TaskPtyTabRecord, TaskRecord } from "../types/task.js";
import { listTasks } from "../services/list-tasks.js";
import { provisionTask } from "../services/task-provisioning.js";
import { addRepo } from "../services/repo-registry.js";
import { loadTaskLocalInspection, type InspectionTreeRow } from "../services/task-local-inspection.js";
import { discoverOrRefreshPullRequest, openPullRequest } from "../services/open-pull-request.js";
import { mergeTask } from "../services/merge-task.js";
import { closeTask } from "../services/close-task.js";
import {
  assertRunnerEnabled,
  buildRunnerCommand,
  getConfiguredRunnerProfile,
  getDefaultRunner,
  getEnabledRunnerIds,
  getRunnerProfile,
} from "../services/runner-profiles.js";
import { runCommand } from "../utils/exec.js";
import { requireExecutablePath, withDefaultCommandPath } from "../utils/command-path.js";
import {
  buildShellData,
  getCombinedDiffLineCount,
  getCombinedDiffPathRanges,
  type WorkspaceShellModel,
} from "./shell-data.js";
import { getViewport, SHELL_LAYOUT, type Viewport } from "./layout.js";
import type { PtyRuntimeOptions, PtySize } from "./pty-runtime.js";
import { createDaemonPtyRuntime } from "./pty-daemon.js";
import { CENTER_TERMINAL_GUTTER, renderBootOverlayFrame, renderHelpOverlayFrame, renderMainShellFrame, renderOptionsOverlayFrame, renderPauseOverlayFrame } from "./render.js";
import {
  buildRunnersSubmenuItems,
  getRunnersSubmenuMessage,
  reduceOptionsMenuKey,
  reduceRunnerOptionsKey,
  OPTIONS_MENU_ITEMS,
  type RunnerOptionsState,
} from "./options.js";
import {
  createInitialShellState,
  buildCenterTabIds,
  isEnterKey,
  isPrintableKey,
  markTerminalAttachFailed,
  getNextRunner,
  reduceMainKey,
  restoreShellState,
  scrollInspectionContent,
  toPersistedUiState,
  updateTerminalViewState,
  type ControlShellState,
  type WorkspaceBrowserEntry,
  type WorkspaceBrowserState,
} from "./state.js";

type OverlayVariant = "boot" | "pause" | "help" | "options" | "runners";
type AppState =
  | {
      mode: "overlay";
      variant: OverlayVariant;
      menuIndex: number;
      optionsMessage: string | null;
      shell: ControlShellState;
      parentVariant?: "boot" | "pause";
      viaOptions?: boolean;
      runnerOptions?: RunnerOptionsState;
    }
  | { mode: "main"; shell: ControlShellState };

/* eslint-disable no-unused-vars */
type TerminalEventListener = (...args: unknown[]) => void;

export interface TerminalAppOptions {
  uiStateFile?: string;
  workspaceRoot?: string;
  terminal?: TerminalRuntime;
  ptyRuntime?: PtyRuntimePort;
}

const require = createRequire(import.meta.url);
const terminalKit = require("terminal-kit") as typeof TerminalKitModule;
const terminal = terminalKit.terminal;

export interface TerminalRuntime {
  width: number | undefined;
  height: number | undefined;
  moveTo(...args: [number, number]): void;
  eraseDisplayBelow(): void;
  noFormat(...args: [string]): void;
  grabInput(...args: [boolean | { mouse: "button" }]): void;
  hideCursor(...args: [boolean?]): void;
  fullscreen(...args: [boolean]): void;
  on(...args: ["key" | "unknown" | "mouse", TerminalEventListener]): void;
  removeListener(...args: ["key" | "unknown" | "mouse", TerminalEventListener]): void;
}

export interface PtyRuntimePort {
  ensureSession(...args: [string, string, PtySize]): ControlShellState["terminal"] | Promise<ControlShellState["terminal"]>;
  hydrateSessions?(...args: [string[]]): void | Promise<void>;
  write(...args: [string]): void;
  writeKey(...args: [string]): void;
  scrollViewport(...args: [number]): void;
  resize(...args: [PtySize]): void;
  detach(): void;
  disposeSession(...args: [string]): void;
  disposeAll(): void;
  getViewState(...args: [string | null]): ControlShellState["terminal"];
}
/* eslint-enable no-unused-vars */

export async function startTerminalApp(options: TerminalAppOptions = {}): Promise<number> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("Craig terminal shell requires a TTY.");
  }

  const workspaceRoot = options.workspaceRoot ?? process.cwd();
  const paths = getCraigPaths(workspaceRoot);
  await ensureCraigState(workspaceRoot);
  let config = await readCraigConfig(paths);
  let enabledRunnerIds = getEnabledRunnerIds(config);
  let runtimeState = options.uiStateFile ? await readUiState({ uiStateFile: options.uiStateFile }) : null;
  let persistQueue = Promise.resolve();
  let taskMutationQueue = Promise.resolve();
  let model = await loadWorkspaceShellModel(workspaceRoot, undefined, enabledRunnerIds);
  const initialShell = restoreShellState(createInitialShellState(runtimeState, config), model);
  model = await loadWorkspaceShellModel(workspaceRoot, initialShell, enabledRunnerIds);
  let handlePtyUpdate: () => void = () => undefined;
  const ptyOptions: PtyRuntimeOptions = {
    workspaceRoot,
    onUpdate: () => handlePtyUpdate(),
    resolveSessionSpec: (_taskId, tabId) => resolvePtySessionSpec(model, tabId, workspaceRoot),
  };
  const initialPtyRuntime: PtyRuntimePort =
    options.ptyRuntime ??
    (await createDaemonPtyRuntime({
      ...ptyOptions,
      paths,
    }));

  const persistShellState = (shell: ControlShellState) => {
    if (!options.uiStateFile) {
      return;
    }

    runtimeState = toPersistedUiState(runtimeState, shell);
    const nextRuntimeState = runtimeState;
    persistQueue = persistQueue.then(
      () => writeUiState({ uiStateFile: options.uiStateFile! }, nextRuntimeState),
      () => writeUiState({ uiStateFile: options.uiStateFile! }, nextRuntimeState),
    );
    void persistQueue.catch(() => undefined);
  };

  return new Promise<number>((resolve) => {
    const activeTerminal = options.terminal ?? terminal;
    let state: AppState = {
      mode: "overlay",
      variant: "boot",
      menuIndex: 0,
      optionsMessage: null,
      shell: restoreShellState(initialShell, model),
    };
    let creatingTask = false;
    let suppressTerminalEnterOnAttach = false;
    let lastTerminalKey: { key: string; at: number } | null = null;
    let pendingScrollLines = 0;
    let pendingInspectionScrollLines = 0;
    let scrollRenderTimer: ReturnType<typeof setTimeout> | null = null;
    let inspectionScrollRenderTimer: ReturnType<typeof setTimeout> | null = null;
    let ptyRenderTimer: ReturnType<typeof setTimeout> | null = null;
    let prPollTimer: ReturnType<typeof setInterval> | null = null;
    let prPollInFlight = false;
    let pendingClear = true;
    let inputCaptureMode: "control" | "terminal" | null = null;
    let render: () => void = () => undefined;
    const ptyRuntime = initialPtyRuntime;
    handlePtyUpdate = () => {
      if (state.mode !== "main") {
        return;
      }

      state = { mode: "main", shell: withTerminalView(state.shell) };

      if (!ptyRenderTimer) {
        ptyRenderTimer = setTimeout(() => {
          ptyRenderTimer = null;
          if (state.mode === "main") {
            render();
          }
        }, 50);
      }
    };

    function withTerminalView(shell: ControlShellState): ControlShellState {
      return updateTerminalViewState(shell, ptyRuntime.getViewState(shell.selectedPtyTabId));
    }

    function syncShell(nextShell: ControlShellState): ControlShellState {
      return withTerminalView(resolveShellState(nextShell, model));
    }

    function getSelectedTask(shell: ControlShellState): TaskRecord | null {
      return model.tasks.find((task) => task.id === shell.selectedTaskId) ?? null;
    }

    async function hydrateOpenPtyTabs(): Promise<void> {
      await ptyRuntime.hydrateSessions?.(model.tasks.flatMap((task) => task.ptyTabs.map((tab) => tab.id)));
    }

    function hydrateAndRenderOpenPtyTabs(): void {
      void hydrateOpenPtyTabs()
        .catch(() => undefined)
        .then(() => {
          if (state.mode !== "main") {
            return;
          }

          state = { mode: "main", shell: withTerminalView(state.shell) };
          render();
        });
    }

    function queueTaskMutation<T>(mutation: () => Promise<T>): Promise<T> {
      const next = taskMutationQueue.then(mutation, mutation);
      taskMutationQueue = next.then(
        () => undefined,
        () => undefined,
      );
      return next;
    }

    function getShellKeyOptions(shell: ControlShellState) {
      const selectedTask = getSelectedTask(shell);
      const inspection = model.inspection;
      const selectedInspection = inspection && inspection.taskId === selectedTask?.id ? inspection : null;
      const fileTreeRows = getVisibleFileTreeRows(selectedInspection?.fileRows ?? [], shell.collapsedFileTreePaths);
      return {
        leftItemIds: getLeftItemIds(model),
        centerTabIds: buildCenterTabIds(selectedTask, shell),
        ptyTabIds: selectedTask?.ptyTabs.map((tab) => tab.id) ?? [],
        filePathIds: selectedInspection?.filePaths ?? [],
        fileTreeRowIds: fileTreeRows.map((row) => row.path),
        fileTreeFileIds: fileTreeRows.filter((row) => row.kind === "file").map((row) => row.path),
        fileTreeDirectoryIds: fileTreeRows.filter((row) => row.kind === "directory").map((row) => row.path),
        diffPathIds: selectedInspection?.diffPaths ?? [],
        diffPathRanges: getCombinedDiffPathRanges(selectedInspection),
        fileLineCount: selectedInspection?.selectedFile.lines.length ?? 0,
        diffLineCount: getCombinedDiffLineCount(selectedInspection),
        pageRows: Math.max(5, getViewport(activeTerminal.width, activeTerminal.height).height - SHELL_LAYOUT.topRailHeight - 9),
        enabledRunnerIds,
      };
    }

    async function updateRunnerOptions(nextConfig: CraigConfig): Promise<void> {
      await writeCraigConfig(paths, nextConfig);
      config = nextConfig;
      enabledRunnerIds = getEnabledRunnerIds(config);
      model = {
        ...model,
        enabledRunnerIds,
      };
      if (state.mode === "main") {
        state = {
          mode: "main",
          shell: syncShell({
            ...state.shell,
            selectedRunner: enabledRunnerIds.includes(state.shell.selectedRunner)
              ? state.shell.selectedRunner
              : getDefaultRunner(config),
          }),
        };
      } else {
        state = {
          ...state,
          shell: syncShell({
            ...state.shell,
            selectedRunner: enabledRunnerIds.includes(state.shell.selectedRunner)
              ? state.shell.selectedRunner
              : getDefaultRunner(config),
          }),
        };
      }
    }

    async function persistTaskPtySelection(shell: ControlShellState): Promise<void> {
      const taskId = shell.selectedTaskId;
      if (!taskId) {
        return;
      }

      await queueTaskMutation(async () => {
        const latestTask = await readTask(paths, taskId);
        if (
          !latestTask.ptyTabs.some((tab) => tab.id === shell.activeTab) ||
          latestTask.selectedPtyTabId === shell.activeTab
        ) {
          return;
        }

        await writeTask(paths, {
          ...latestTask,
          selectedPtyTabId: shell.activeTab,
        });
      });
    }

    async function reloadModel(): Promise<void> {
      const shell = state.mode === "main" ? state.shell : state.shell;
      model = await loadWorkspaceShellModel(workspaceRoot, shell, enabledRunnerIds);
      if (state.mode === "main") {
        state = { mode: "main", shell: syncShell(state.shell) };
      } else {
        state = { ...state, shell: syncShell(state.shell) };
      }
    }

    async function refreshInspection(shell: ControlShellState): Promise<void> {
      model = await loadWorkspaceShellModel(workspaceRoot, shell, enabledRunnerIds);
      if (state.mode === "main") {
        state = { mode: "main", shell: syncShell(shell) };
      }
      persistShellState(state.shell);
      render();
    }

    async function openWorkspaceBrowser(rootPath: string): Promise<void> {
      const browser = await loadWorkspaceBrowser(rootPath);
      if (state.mode !== "main") {
        return;
      }

      state = {
        mode: "main",
        shell: syncShell({
          ...state.shell,
          workspaceBrowser: browser,
          activeTab: state.shell.selectedPtyTabId ?? state.shell.activeTab,
          actionMessage: null,
        }),
      };
      render();
    }

    async function attachPtyFromShell(shell: ControlShellState): Promise<void> {
      try {
        const syncedShell = syncShell(shell);
        let selectedTask = getSelectedTask(syncedShell);
        let tabId = syncedShell.selectedPtyTabId;

        if (selectedTask && syncedShell.focusedRegion === "tasks") {
          const agentTab = selectedTask.ptyTabs.find((tab) => tab.kind === "agent") ?? null;
          if (agentTab) {
            tabId = agentTab.id;
          } else {
            selectedTask = await ensureDefaultAgentTab(selectedTask);
            await reloadModel();
            tabId = selectedTask.selectedPtyTabId;
          }
        }

        if (selectedTask && !tabId) {
          selectedTask = await ensureDefaultAgentTab(selectedTask);
          await reloadModel();
          tabId = selectedTask.selectedPtyTabId;
        }

        const nextShell = syncShell({
          ...syncedShell,
          activeTab: tabId ?? syncedShell.activeTab,
          selectedPtyTabId: tabId,
        });

        if (!nextShell.selectedTaskId || !tabId) {
          state = { mode: "main", shell: nextShell };
          render();
          return;
        }

        state = {
          mode: "main",
          shell: updateTerminalViewState({ ...nextShell, inputMode: "terminal" }, ptyRuntime.getViewState(tabId)),
        };
        persistShellState(state.shell);
        const view = await ptyRuntime.ensureSession(
          nextShell.selectedTaskId,
          tabId,
          getPtySize(getViewport(activeTerminal.width, activeTerminal.height)),
        );
        suppressTerminalEnterOnAttach = isAgentTabId(tabId);
        lastTerminalKey = null;
        state = { mode: "main", shell: updateTerminalViewState({ ...nextShell, inputMode: "terminal" }, view) };
        persistShellState(state.shell);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to start PTY.";
        if (shell.selectedTaskId && shell.selectedPtyTabId && isAgentTabId(shell.selectedPtyTabId)) {
          await markTaskRunnerFailed(shell.selectedTaskId, message).catch(() => undefined);
          await reloadModel().catch(() => undefined);
        }
        state = { mode: "main", shell: markTerminalAttachFailed(syncShell(shell), message) };
        persistShellState(state.shell);
      }
      render();
    }

    async function markTaskRunnerFailed(taskId: string, message: string): Promise<void> {
      await queueTaskMutation(async () => {
        const task = await readTask(paths, taskId);
        await writeTask(paths, {
          ...task,
          status: task.status === "running" ? "draft" : task.status,
          runnerSession: {
            ...task.runnerSession,
            lastKnownState: "failed",
            exitedAt: new Date().toISOString(),
          },
          lastFailureReason: message,
        });
      });
    }

    async function createPtyTabFromShell(shell: ControlShellState, requestedKind: TaskPtyTabRecord["kind"] | null, requestedRunner?: RunnerType | null): Promise<ControlShellState> {
      const syncedShell = syncShell(shell);
      if (!syncedShell.selectedTaskId) {
        throw new Error("Select a task before creating a tab.");
      }

      const updatedTask = await queueTaskMutation(async () => {
        const task = await readTask(paths, syncedShell.selectedTaskId!);
        const kind = requestedKind ?? resolveNewPtyTabKind(task, syncedShell.activeTab, syncedShell.preferredPtyTabKind);
        const tab = createNextPtyTab(task, kind, requestedRunner ?? undefined, config);
        const nextTask: TaskRecord = {
          ...task,
          ptyTabs: [...task.ptyTabs, tab],
          selectedPtyTabId: tab.id,
        };
        await writeTask(paths, nextTask);
        return nextTask;
      });
      await reloadModel();

      return syncShell({
        ...syncedShell,
        activeTab: updatedTask.selectedPtyTabId ?? syncedShell.activeTab,
        selectedPtyTabId: updatedTask.selectedPtyTabId,
        preferredPtyTabKind: updatedTask.ptyTabs.at(-1)?.kind ?? syncedShell.preferredPtyTabKind,
        focusedRegion: "center",
        actionMessage: `Created tab: ${updatedTask.ptyTabs.at(-1)?.title ?? "tab"}`,
      });
    }

    async function closePtyTabFromShell(shell: ControlShellState): Promise<ControlShellState> {
      const syncedShell = syncShell(shell);
      if (!syncedShell.selectedTaskId) {
        throw new Error("Select a task before closing a tab.");
      }

      const { closedTab, nextSelectedTab } = await queueTaskMutation(async () => {
        const task = await readTask(paths, syncedShell.selectedTaskId!);
        const closedIndex = task.ptyTabs.findIndex((tab) => tab.id === syncedShell.activeTab);
        if (closedIndex === -1) {
          throw new Error("Only PTY tabs can be closed.");
        }

        const closedTab = task.ptyTabs[closedIndex]!;
        const remainingTabs = task.ptyTabs.filter((tab) => tab.id !== closedTab.id);
        const nextSelectedTab =
          remainingTabs[Math.min(closedIndex, remainingTabs.length - 1)] ?? remainingTabs[closedIndex - 1] ?? null;
        await writeTask(paths, {
          ...task,
          ptyTabs: remainingTabs,
          selectedPtyTabId: nextSelectedTab?.id ?? null,
        });
        return { closedTab, nextSelectedTab };
      });
      ptyRuntime.disposeSession(closedTab.id);
      await reloadModel();

      return syncShell({
        ...syncedShell,
        activeTab: nextSelectedTab?.id ?? (syncedShell.openInspectionKind ? "inspection" : syncedShell.activeTab),
        selectedPtyTabId: nextSelectedTab?.id ?? null,
        focusedRegion: "center",
        actionMessage: `Closed tab: ${closedTab.title}`,
      });
    }

    async function syncPullRequestFromShell(shell: ControlShellState): Promise<ControlShellState> {
      const syncedShell = syncShell(shell);
      if (!syncedShell.selectedTaskId) {
        throw new Error("Select a task before creating or syncing a PR.");
      }

      const result = await openPullRequest(paths, syncedShell.selectedTaskId, { watch: false });
      await reloadModel();

      const action = result.disposition === "created"
        ? "Created PR"
        : result.disposition === "discovered"
          ? "Discovered PR"
          : "Synced PR";
      return syncShell({
        ...syncedShell,
        focusedRegion: "inspector",
        inspectionMode: "review",
        actionMessage: `${action}: #${result.prNumber} ${result.url}`,
      });
    }

    async function refreshPullRequestChecksFromShell(shell: ControlShellState): Promise<ControlShellState> {
      const syncedShell = syncShell(shell);
      if (!syncedShell.selectedTaskId) {
        throw new Error("Select a task before refreshing PR checks.");
      }

      const { disposition, task } = await discoverOrRefreshPullRequest(paths, syncedShell.selectedTaskId);
      await reloadModel();

      const actionMessage = disposition === "not_found"
        ? `No PR found for ${task.branch}`
        : disposition === "discovered"
          ? `Discovered PR: #${task.pullRequest.number} ${task.pullRequest.url ?? ""}`
          : `Refreshed checks: ${task.pullRequest.requiredChecks.length} reported`;

      return syncShell({
        ...syncedShell,
        focusedRegion: "inspector",
        inspectionMode: "review",
        selectedActionId: "refresh-checks",
        actionMessage,
      });
    }

    async function pollSelectedPullRequest(): Promise<void> {
      if (prPollInFlight || state.mode !== "main" || !state.shell.selectedTaskId) {
        return;
      }

      const taskId = state.shell.selectedTaskId;
      const previousTask = model.tasks.find((task) => task.id === taskId) ?? null;
      const hadPr = Boolean(previousTask?.pullRequest.number);
      prPollInFlight = true;

      try {
        const { disposition, task } = await discoverOrRefreshPullRequest(paths, taskId);

        if (state.mode !== "main" || state.shell.selectedTaskId !== taskId) {
          return;
        }

        model = await loadWorkspaceShellModel(workspaceRoot, state.shell, enabledRunnerIds);
        state = {
          mode: "main",
          shell: syncShell({
            ...state.shell,
            actionMessage: disposition === "discovered" && !hadPr
              ? `Discovered PR: #${task.pullRequest.number} ${task.pullRequest.url ?? ""}`
              : state.shell.actionMessage,
          }),
        };
        render();
      } catch {
        // Background PR discovery should never interrupt agent input or review work.
      } finally {
        prPollInFlight = false;
      }
    }

    async function mergeTaskFromShell(shell: ControlShellState): Promise<ControlShellState> {
      const syncedShell = syncShell(shell);
      if (!syncedShell.selectedTaskId) {
        throw new Error("Select a task before merging a PR.");
      }

      const result = await mergeTask(paths, syncedShell.selectedTaskId, { preserveWorktree: true });
      await reloadModel();

      return syncShell({
        ...syncedShell,
        focusedRegion: "inspector",
        inspectionMode: "review",
        selectedActionId: "merge",
        actionMessage: `Merged PR #${result.prNumber}; worktree preserved`,
      });
    }

    async function closeTaskFromShell(shell: ControlShellState): Promise<ControlShellState> {
      const syncedShell = syncShell(shell);
      if (!syncedShell.selectedTaskId) {
        throw new Error("Select a task before closing it.");
      }

      const { taskBeforeClose, task } = await queueTaskMutation(async () => {
        const taskBeforeClose = await readTask(paths, syncedShell.selectedTaskId!);
        const task = await closeTask(paths, syncedShell.selectedTaskId!);
        return { taskBeforeClose, task };
      });
      for (const tab of taskBeforeClose.ptyTabs) {
        ptyRuntime.disposeSession(tab.id);
      }
      await reloadModel();

      return syncShell({
        ...syncedShell,
        selectedActionId: "close-task",
        actionMessage: task.cleanup.preservedWorktree
          ? `Archived task ${task.id}; worktree preserved`
          : `Archived task ${task.id}`,
      });
    }

    async function ensureDefaultAgentTab(task: TaskRecord): Promise<TaskRecord> {
      const agentTab = task.ptyTabs.find((tab) => tab.kind === "agent") ?? null;
      if (agentTab) {
        const updatedTask = {
          ...task,
          selectedPtyTabId: agentTab.id,
        };
        await queueTaskMutation(async () => {
          const latestTask = await readTask(paths, task.id);
          const latestAgentTab = latestTask.ptyTabs.find((tab) => tab.kind === "agent") ?? null;
          if (!latestAgentTab) {
            return;
          }

          await writeTask(paths, {
            ...latestTask,
            selectedPtyTabId: latestAgentTab.id,
          });
        });
        return updatedTask;
      }

      const tab = createNextPtyTab(task, "agent", undefined, config);
      const updatedTask = {
        ...task,
        ptyTabs: [...task.ptyTabs, tab],
        selectedPtyTabId: tab.id,
      };
      await queueTaskMutation(async () => {
        const latestTask = await readTask(paths, task.id);
        const latestAgentTab = latestTask.ptyTabs.find((entry) => entry.kind === "agent") ?? null;
        if (latestAgentTab) {
          await writeTask(paths, {
            ...latestTask,
            selectedPtyTabId: latestAgentTab.id,
          });
          return;
        }

        await writeTask(paths, {
          ...latestTask,
          ptyTabs: [...latestTask.ptyTabs, tab],
          selectedPtyTabId: tab.id,
        });
      });
      return updatedTask;
    }

    render = () => {
      syncInputCapture();
      const viewport = getViewport(activeTerminal.width, activeTerminal.height);
      const frame =
        state.mode === "main"
          ? renderMainShellFrame(viewport, buildShellData(syncShell(state.shell), model), { centerOnly: state.shell.centerZoomed })
          : state.variant === "boot"
            ? renderBootOverlayFrame(viewport, { menuIndex: state.menuIndex, optionsMessage: state.optionsMessage })
            : state.variant === "pause"
              ? renderPauseOverlayFrame(viewport, { menuIndex: state.menuIndex, optionsMessage: state.optionsMessage })
              : state.variant === "options"
                ? renderOptionsOverlayFrame(viewport, {
                    menuIndex: state.menuIndex,
                    optionsMenuItems: OPTIONS_MENU_ITEMS,
                  })
                : state.variant === "runners"
                  ? renderOptionsOverlayFrame(viewport, {
                      menuIndex: getRunnerOptionsState(state).menuIndex,
                      optionsMenuItems: buildRunnersSubmenuItems(config, getRunnerOptionsState(state)),
                      optionsMessage: getRunnersSubmenuMessage(getRunnerOptionsState(state)),
                      optionsSubtitle: "Runners",
                    })
                  : renderHelpOverlayFrame(viewport);

      activeTerminal.moveTo(1, 1);
      if (pendingClear) {
        activeTerminal.eraseDisplayBelow();
        pendingClear = false;
      }
      activeTerminal.noFormat(frame);

      activeTerminal.hideCursor(true);
    };

    function syncInputCapture(): void {
      const nextMode = state.mode === "main" && state.shell.inputMode === "terminal"
        ? "terminal"
        : "control";
      if (nextMode === inputCaptureMode) {
        return;
      }

      inputCaptureMode = nextMode;
      activeTerminal.grabInput(nextMode === "terminal" ? { mouse: "button" } : true);
    }

    const cleanup = () => {
      process.stdout.off("resize", handleResize);
      activeTerminal.removeListener("key", onKey);
      activeTerminal.removeListener("unknown", onUnknown);
      activeTerminal.removeListener("mouse", onMouse);
      if (scrollRenderTimer) {
        clearTimeout(scrollRenderTimer);
        scrollRenderTimer = null;
      }
      if (inspectionScrollRenderTimer) {
        clearTimeout(inspectionScrollRenderTimer);
        inspectionScrollRenderTimer = null;
      }
      if (ptyRenderTimer) {
        clearTimeout(ptyRenderTimer);
        ptyRenderTimer = null;
      }
      if (prPollTimer) {
        clearInterval(prPollTimer);
        prPollTimer = null;
      }
      ptyRuntime.disposeAll();
      activeTerminal.grabInput(false);
      activeTerminal.hideCursor(false);
      activeTerminal.fullscreen(false);
    };

    const exit = (code: number) => {
      cleanup();
      resolve(code);
    };

    const submitTaskPrompt = async () => {
      if (state.mode !== "main" || creatingTask) {
        return;
      }

      const shell = state.shell;
      const prompt = shell.taskPromptInput?.trim() ?? "";

      if (!shell.selectedRepoId) {
        state = { mode: "main", shell: syncShell({ ...shell, taskPromptError: "Select a repo first." }) };
        render();
        return;
      }

      if (prompt.length === 0) {
        state = { mode: "main", shell: syncShell({ ...shell, taskPromptError: "Task prompt cannot be empty." }) };
        render();
        return;
      }

      creatingTask = true;
      state = {
        mode: "main",
        shell: syncShell({
          ...shell,
          actionMessage: `Creating ${shell.selectedRunner} task in ${shell.selectedRepoId}...`,
        }),
      };
      render();

      let createdTask: TaskRecord | null = null;
      try {
        createdTask = await createInteractiveTask(paths, shell.selectedRepoId, prompt, shell.selectedRunner);
        await reloadModel();
        const nextShell = syncShell({
          ...state.shell,
          selectedRepoId: createdTask.repoId,
          selectedTaskId: createdTask.id,
          selectedPtyTabId: createdTask.selectedPtyTabId,
          selectedLeftItemId: `task:${createdTask.id}`,
          activeTab: createdTask.selectedPtyTabId ?? "agent",
          inputMode: "terminal",
          taskPromptInput: null,
          taskPromptError: null,
          actionMessage: null,
        });
        const view = await ptyRuntime.ensureSession(
          createdTask.id,
          nextShell.selectedPtyTabId ?? getRequiredPtyTabId(createdTask, "agent"),
          getPtySize(getViewport(activeTerminal.width, activeTerminal.height)),
        );
        suppressTerminalEnterOnAttach = isAgentTabId(nextShell.selectedPtyTabId);
        state = { mode: "main", shell: updateTerminalViewState(nextShell, view) };
        persistShellState(state.shell);
      } catch (error) {
        if (error instanceof InteractiveTaskStartupError) {
          createdTask = error.task;
        }
        const message = error instanceof Error ? error.message : "Failed to create task.";
        if (createdTask) {
          await writeTask(paths, {
            ...createdTask,
            status: "draft",
            runnerSession: {
              ...createdTask.runnerSession,
              lastKnownState: "failed",
              exitedAt: new Date().toISOString(),
            },
            lastFailureReason: message,
          }).catch(() => undefined);
          await reloadModel().catch(() => undefined);
        }
        state = {
          mode: "main",
          shell: syncShell({
            ...state.shell,
            inputMode: "control",
            selectedTaskId: createdTask?.id ?? state.shell.selectedTaskId,
            selectedPtyTabId: createdTask?.selectedPtyTabId ?? state.shell.selectedPtyTabId,
            selectedLeftItemId: createdTask ? `task:${createdTask.id}` : state.shell.selectedLeftItemId,
            activeTab: createdTask?.selectedPtyTabId ?? state.shell.activeTab,
            taskPromptInput: createdTask ? null : "",
            taskPromptError: message,
            actionMessage: null,
          }),
        };
      } finally {
        creatingTask = false;
        render();
      }
    };

    const handlePromptKey = (key: string) => {
      if (state.mode !== "main") {
        return;
      }

      const shell = state.shell;
      if (shell.taskPromptInput === null) {
        return;
      }

      if (key === "ESCAPE") {
        state = {
          mode: "main",
          shell: syncShell({ ...shell, taskPromptInput: null, taskPromptError: null, actionMessage: null }),
        };
        render();
        return;
      }

      if (isEnterKey(key)) {
        void submitTaskPrompt();
        return;
      }

      if (key === "BACKSPACE") {
        state = {
          mode: "main",
          shell: syncShell({
            ...shell,
            taskPromptInput: shell.taskPromptInput.slice(0, -1),
            taskPromptError: null,
          }),
        };
        render();
        return;
      }

      if (key === "CTRL_R") {
        state = {
          mode: "main",
          shell: syncShell({
            ...shell,
            selectedRunner: getNextRunner(shell.selectedRunner, enabledRunnerIds),
            taskPromptError: null,
          }),
        };
        render();
        return;
      }

      if (isPrintableKey(key)) {
        state = {
          mode: "main",
          shell: syncShell({
            ...shell,
            taskPromptInput: `${shell.taskPromptInput}${key}`,
            taskPromptError: null,
          }),
        };
        render();
      }
    };

    const handleWorkspaceBrowserKey = (key: string) => {
      if (state.mode !== "main") {
        return;
      }

      const browser = state.shell.workspaceBrowser;
      if (!browser) {
        return;
      }

      if (key === "ESCAPE") {
        state = {
          mode: "main",
          shell: syncShell({ ...state.shell, workspaceBrowser: null, actionMessage: null }),
        };
        render();
        return;
      }

      if (key === "UP" || key === "k") {
        state = {
          mode: "main",
          shell: syncShell({
            ...state.shell,
            workspaceBrowser: {
              ...browser,
              selectedIndex: Math.max(0, browser.selectedIndex - 1),
              error: null,
            },
          }),
        };
        render();
        return;
      }

      if (key === "DOWN" || key === "j") {
        const maxIndex = Math.max(0, browser.entries.length - 1);
        state = {
          mode: "main",
          shell: syncShell({
            ...state.shell,
            workspaceBrowser: {
              ...browser,
              selectedIndex: Math.min(maxIndex, browser.selectedIndex + 1),
              error: null,
            },
          }),
        };
        render();
        return;
      }

      if (key === "LEFT" || key === "h") {
        void openWorkspaceBrowser(path.dirname(browser.cwd)).catch((error: unknown) => {
          const message = error instanceof Error ? error.message : "Failed to open parent directory.";
          state = {
            mode: "main",
            shell: syncShell({
              ...state.shell,
              workspaceBrowser: {
                ...browser,
                error: message,
              },
            }),
          };
          render();
        });
        return;
      }

      if (key === "RIGHT" || key === "l" || isEnterKey(key)) {
        const selectedEntry = browser.entries[browser.selectedIndex] ?? null;

        if (!selectedEntry) {
          return;
        }

        if (selectedEntry.kind === "directory" || ((key === "RIGHT" || key === "l") && selectedEntry.kind === "repo")) {
          void openWorkspaceBrowser(selectedEntry.path).catch((error: unknown) => {
            const message = error instanceof Error ? error.message : "Failed to open directory.";
            state = {
              mode: "main",
              shell: syncShell({
                ...state.shell,
                workspaceBrowser: {
                  ...browser,
                  error: message,
                },
              }),
            };
            render();
          });
          return;
        }

        void addRepo(paths, selectedEntry.path)
          .then(async (result) => {
            await reloadModel();
            const nextShell = syncShell({
              ...state.shell,
              workspaceBrowser: null,
              selectedLeftItemId: `repo:${result.repo.id}`,
              selectedRepoId: result.repo.id,
              selectedTaskId: null,
              selectedPtyTabId: null,
              actionMessage: `Registered workspace: ${result.repo.name}`,
            });
            state = { mode: "main", shell: nextShell };
            persistShellState(state.shell);
            render();
          })
          .catch((error: unknown) => {
            const message = error instanceof Error ? error.message : "Failed to add workspace.";
            state = {
              mode: "main",
              shell: syncShell({
                ...state.shell,
                workspaceBrowser: {
                  ...browser,
                  error: message,
                },
              }),
            };
            render();
          });
      }
    };

    const onKey = (name: unknown) => {
      const key = typeof name === "string" ? name : "";

      if (state.mode === "main" && state.shell.taskPromptInput !== null) {
        handlePromptKey(key);
        return;
      }

      if (state.mode === "main" && state.shell.workspaceBrowser !== null) {
        handleWorkspaceBrowserKey(key);
        return;
      }

      if (state.mode === "main") {
        const result = reduceMainKey(state.shell, key, getShellKeyOptions(state.shell));

        if (result.exit) {
          exit(0);
          return;
        }

        if (result.detachTerminal) {
          ptyRuntime.detach();
          state = { mode: "main", shell: syncShell(result.state) };
          persistShellState(state.shell);
          render();
          return;
        }

        if (state.shell.inputMode === "terminal") {
          if (result.changed) {
            state = { mode: "main", shell: syncShell(result.state) };
            persistShellState(state.shell);
            render();
            return;
          }

          if (suppressTerminalEnterOnAttach && isEnterKey(key)) {
            suppressTerminalEnterOnAttach = false;
            return;
          }

          if (suppressTerminalEnterOnAttach) {
            suppressTerminalEnterOnAttach = false;
          }

          lastTerminalKey = shouldTrackTerminalKey(key) ? { key, at: Date.now() } : null;

          const scrollLines = getTerminalScrollLinesForKey(key, state.shell.terminal.scrolledBack ?? false);
          if (scrollLines !== 0) {
            scheduleTerminalViewportScroll(scrollLines);
            return;
          }

          ptyRuntime.writeKey(key);
          return;
        }

        if (key === "CTRL_C") {
          exit(0);
          return;
        }

        if (key === "?" && state.shell.inputMode === "control") {
          state = { mode: "overlay", variant: "help", menuIndex: 0, optionsMessage: null, shell: state.shell };
          pendingClear = true;
          render();
          return;
        }


        if (result.pause) {
          state = { mode: "overlay", variant: "pause", menuIndex: 0, optionsMessage: null, shell: syncShell(result.state) };
          pendingClear = true;
          render();
          return;
        }

        if (result.beginTaskPrompt) {
          state = { mode: "main", shell: syncShell(result.state) };
          persistShellState(state.shell);
          render();
          return;
        }

        if (result.openWorkspaceBrowser) {
          void openWorkspaceBrowser(workspaceRoot).catch((error: unknown) => {
            const message = error instanceof Error ? error.message : "Failed to browse workspaces.";
            state = {
              mode: "main",
              shell: syncShell({
                ...result.state,
                workspaceBrowser: {
                  cwd: workspaceRoot,
                  entries: [],
                  selectedIndex: 0,
                  error: message,
                },
              }),
            };
            render();
          });
          return;
        }

        if (result.createPtyTab) {
          void createPtyTabFromShell(result.state, result.createPtyTabKind, result.createPtyTabRunner)
            .then((nextShell) => {
              void attachPtyFromShell(nextShell);
            })
            .catch((error: unknown) => {
              const message = error instanceof Error ? error.message : "Failed to create tab.";
              state = { mode: "main", shell: syncShell({ ...result.state, actionMessage: message }) };
              render();
            });
          return;
        }

        if (result.closePtyTab) {
          void closePtyTabFromShell(result.state)
            .then((nextShell) => {
              state = { mode: "main", shell: nextShell };
              persistShellState(state.shell);
              render();
            })
            .catch((error: unknown) => {
              const message = error instanceof Error ? error.message : "Failed to close tab.";
              state = { mode: "main", shell: syncShell({ ...result.state, actionMessage: message }) };
              render();
            });
          return;
        }

        if (result.syncPullRequest) {
          void syncPullRequestFromShell(result.state)
            .then((nextShell) => {
              state = { mode: "main", shell: nextShell };
              persistShellState(state.shell);
              render();
            })
            .catch((error: unknown) => {
              const message = error instanceof Error ? error.message : "Failed to create or sync PR.";
              state = { mode: "main", shell: syncShell({ ...result.state, actionMessage: message }) };
              render();
            });
          return;
        }

        if (result.refreshPullRequestChecks) {
          void refreshPullRequestChecksFromShell(result.state)
            .then((nextShell) => {
              state = { mode: "main", shell: nextShell };
              persistShellState(state.shell);
              render();
            })
            .catch((error: unknown) => {
              const message = error instanceof Error ? error.message : "Failed to refresh PR checks.";
              state = { mode: "main", shell: syncShell({ ...result.state, actionMessage: message }) };
              render();
            });
          return;
        }

        if (result.mergeTask) {
          void mergeTaskFromShell(result.state)
            .then((nextShell) => {
              state = { mode: "main", shell: nextShell };
              persistShellState(state.shell);
              render();
            })
            .catch((error: unknown) => {
              const message = error instanceof Error ? error.message : "Failed to merge PR.";
              state = { mode: "main", shell: syncShell({ ...result.state, actionMessage: message }) };
              render();
            });
          return;
        }

        if (result.closeTask) {
          void closeTaskFromShell(result.state)
            .then((nextShell) => {
              state = { mode: "main", shell: nextShell };
              persistShellState(state.shell);
              render();
            })
            .catch((error: unknown) => {
              const message = error instanceof Error ? error.message : "Failed to close task.";
              state = { mode: "main", shell: syncShell({ ...result.state, actionMessage: message }) };
              render();
            });
          return;
        }

        if (result.attachTerminal) {
          void attachPtyFromShell(result.state);
          return;
        }

        if (result.refreshInspection) {
          void refreshInspection(result.state).catch((error: unknown) => {
            const message = error instanceof Error ? error.message : "Failed to refresh inspection.";
            state = { mode: "main", shell: syncShell({ ...result.state, actionMessage: message }) };
            render();
          });
          return;
        }

        if (result.changed) {
          state = { mode: "main", shell: syncShell(result.state) };
          void persistTaskPtySelection(state.shell).catch(() => undefined);
          persistShellState(state.shell);
          render();
        }
        return;
      }

      if (state.variant === "help") {
        if (state.viaOptions && state.parentVariant) {
          state = { mode: "overlay", variant: "options", menuIndex: 1, optionsMessage: null, shell: state.shell, parentVariant: state.parentVariant };
        } else if (state.parentVariant) {
          state = { mode: "overlay", variant: state.parentVariant, menuIndex: 1, optionsMessage: null, shell: state.shell };
        } else {
          state = { mode: "main", shell: syncShell(state.shell) };
        }
        pendingClear = true;
        render();
        return;
      }

      if (state.variant === "options") {
        handleOptionsMenuKey(key);
        return;
      }

      if (state.variant === "runners") {
        handleRunnersKey(key);
        return;
      }

      if (state.optionsMessage) {
        if (key === "ESCAPE" || isEnterKey(key)) {
          state = { ...state, optionsMessage: null };
          render();
        }
        return;
      }

      if (key === "UP" || key === "k") {
        state = {
          ...state,
          menuIndex: Math.max(0, state.menuIndex - 1),
        };
        render();
        return;
      }

      if (key === "DOWN" || key === "j") {
        state = {
          ...state,
          menuIndex: Math.min(2, state.menuIndex + 1),
        };
        render();
        return;
      }

      if (key === "ESCAPE") {
        if (state.variant === "pause") {
          state = { mode: "main", shell: syncShell(state.shell) };
          pendingClear = true;
          render();
        }
        return;
      }

      if (!isEnterKey(key)) {
        return;
      }

      if (state.menuIndex === 0) {
        state = { mode: "main", shell: syncShell({ ...state.shell, inputMode: "control" }) };
        pendingClear = true;
        render();
        hydrateAndRenderOpenPtyTabs();
        return;
      }

      if (state.menuIndex === 1) {
        const parentVariant = state.variant === "boot" || state.variant === "pause" ? state.variant : undefined;
        state = { mode: "overlay", variant: "options", menuIndex: 0, optionsMessage: null, shell: state.shell, ...(parentVariant !== undefined ? { parentVariant } : {}) };
        pendingClear = true;
        render();
        return;
      }

      exit(0);
    };

    function handleOptionsMenuKey(key: string): void {
      if (state.mode !== "overlay" || state.variant !== "options") {
        return;
      }

      const result = reduceOptionsMenuKey(state.menuIndex, key);

      if (result.kind === "noop") {
        return;
      }

      if (result.kind === "render") {
        state = { ...state, menuIndex: result.menuIndex };
        render();
        return;
      }

      if (result.kind === "back") {
        if (state.parentVariant) {
          state = { mode: "overlay", variant: state.parentVariant, menuIndex: 1, optionsMessage: null, shell: state.shell };
          pendingClear = true;
          render();
        }
        return;
      }

      if (result.kind === "help") {
        const parentVariant = state.parentVariant;
        state = { mode: "overlay", variant: "help", menuIndex: 0, optionsMessage: null, shell: state.shell, viaOptions: true, ...(parentVariant !== undefined ? { parentVariant } : {}) };
        pendingClear = true;
        render();
        return;
      }

      if (result.kind === "runners") {
        const parentVariant = state.parentVariant;
        state = { mode: "overlay", variant: "runners", menuIndex: 0, optionsMessage: null, shell: state.shell, ...(parentVariant !== undefined ? { parentVariant } : {}) };
        pendingClear = true;
        render();
      }
    }

    function handleRunnersKey(key: string): void {
      if (state.mode !== "overlay" || state.variant !== "runners") {
        return;
      }

      const result = reduceRunnerOptionsKey(getRunnerOptionsState(state), config, key, enabledRunnerIds);
      if (result.kind === "noop") {
        return;
      }

      if (result.kind === "back") {
        const parentVariant = state.parentVariant;
        state = { mode: "overlay", variant: "options", menuIndex: 0, optionsMessage: null, shell: state.shell, ...(parentVariant !== undefined ? { parentVariant } : {}) };
        pendingClear = true;
        render();
        return;
      }

      if (result.kind === "render") {
        state = { ...state, runnerOptions: result.state };
        render();
        return;
      }

      void updateRunnerOptions(result.config)
        .then(() => {
          if (state.mode !== "overlay" || state.variant !== "runners") {
            return;
          }
          state = { ...state, runnerOptions: result.state };
          render();
        })
        .catch((error: unknown) => {
          if (state.mode !== "overlay" || state.variant !== "runners") {
            return;
          }
          const message = error instanceof Error ? error.message : "Failed to save runner option.";
          state = {
            ...state,
            runnerOptions: {
              ...getRunnerOptionsState(state),
              message,
            },
          };
          render();
        });
    }

    const onUnknown = (input: unknown) => {
      const raw = inputToString(input);
      if (state.mode !== "main" || state.shell.inputMode !== "terminal" || raw.length === 0) {
        return;
      }

      if (raw.includes("\u001D")) {
        ptyRuntime.detach();
        suppressTerminalEnterOnAttach = false;
        lastTerminalKey = null;
        state = { mode: "main", shell: syncShell({ ...state.shell, inputMode: "control", actionMessage: null }) };
        persistShellState(state.shell);
        render();
        return;
      }

      const scrollLines = getTerminalScrollLinesForRawInput(raw);
      if (scrollLines !== 0) {
        scheduleTerminalViewportScroll(scrollLines);
        return;
      }

      if (suppressTerminalEnterOnAttach && raw !== "\r" && raw !== "\n" && raw !== "\r\n") {
        suppressTerminalEnterOnAttach = false;
      }

      if (shouldSuppressRawTerminalInput(suppressTerminalEnterOnAttach, lastTerminalKey, raw)) {
        suppressTerminalEnterOnAttach = false;
        return;
      }

      ptyRuntime.write(raw);
    };

    const onMouse = (name: unknown) => {
      if (state.mode !== "main") {
        return;
      }

      if (state.shell.inputMode === "control") {
        scheduleInspectionViewportScroll(getTerminalScrollLinesForMouseEvent(name));
        return;
      }

      const scrollLines = getTerminalScrollLinesForMouseEvent(name);
      if (scrollLines === 0) {
        return;
      }

      scheduleTerminalViewportScroll(scrollLines);
    };

    function scheduleTerminalViewportScroll(lines: number): void {
      pendingScrollLines += lines;

      if (scrollRenderTimer) {
        return;
      }

      scrollRenderTimer = setTimeout(() => {
        scrollRenderTimer = null;
        const linesToScroll = pendingScrollLines;
        pendingScrollLines = 0;

        if (linesToScroll === 0) {
          return;
        }

        scrollTerminalViewport(linesToScroll);
        render();
      }, 16);
    }

    function scrollTerminalViewport(lines: number): void {
      ptyRuntime.scrollViewport(lines);
      state = { mode: "main", shell: withTerminalView(state.shell) };
    }

    function scheduleInspectionViewportScroll(lines: number): void {
      if (lines === 0) {
        return;
      }

      pendingInspectionScrollLines += lines;

      if (inspectionScrollRenderTimer) {
        return;
      }

      inspectionScrollRenderTimer = setTimeout(() => {
        inspectionScrollRenderTimer = null;
        const linesToScroll = pendingInspectionScrollLines;
        pendingInspectionScrollLines = 0;

        if (linesToScroll === 0 || state.mode !== "main" || state.shell.inputMode !== "control") {
          return;
        }

        const result = scrollInspectionContent(state.shell, linesToScroll, getShellKeyOptions(state.shell));
        if (!result.changed) {
          return;
        }

        if (result.refreshInspection) {
          void refreshInspection(result.state).catch((error: unknown) => {
            const message = error instanceof Error ? error.message : "Failed to refresh inspection.";
            state = { mode: "main", shell: syncShell({ ...result.state, actionMessage: message }) };
            render();
          });
          return;
        }

        state = { mode: "main", shell: syncShell(result.state) };
        persistShellState(state.shell);
        render();
      }, 16);
    }

    const handleResize = () => {
      pendingClear = true;

      if (state.mode === "main" && state.shell.inputMode === "terminal") {
        ptyRuntime.resize(getPtySize(getViewport(activeTerminal.width, activeTerminal.height)));
        state = { mode: "main", shell: withTerminalView(state.shell) };
      }

      render();
    };

    process.stdout.on("resize", handleResize);
    activeTerminal.grabInput(true);
    inputCaptureMode = "control";
    activeTerminal.hideCursor(true);
    activeTerminal.fullscreen(true);
    activeTerminal.on("key", onKey);
    activeTerminal.on("unknown", onUnknown);
    activeTerminal.on("mouse", onMouse);
    prPollTimer = setInterval(() => {
      void pollSelectedPullRequest();
    }, (config.github?.watchIntervalSeconds ?? 10) * 1000);
    render();
  });
}

async function loadWorkspaceShellModel(
  workspaceRoot: string,
  shell?: ControlShellState,
  enabledRunnerIds?: RunnerType[],
): Promise<WorkspaceShellModel> {
  const paths = getCraigPaths(workspaceRoot);
  const [repos, taskResult] = await Promise.all([listRepos(paths), listTasks(paths)]);
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
    repos,
    tasks: taskResult.tasks,
    inspection,
    ...(enabledRunnerIds ? { enabledRunnerIds } : {}),
  };
}

function resolveSelectedTaskForInspection(tasks: TaskRecord[], shell: ControlShellState | undefined): TaskRecord | null {
  if (!shell?.selectedTaskId) {
    return null;
  }

  return tasks.find((task) => task.id === shell.selectedTaskId) ?? null;
}

function resolveShellState(state: ControlShellState, model: WorkspaceShellModel): ControlShellState {
  return restoreShellState(state, model);
}

function getVisibleFileTreeRows(rows: InspectionTreeRow[], collapsedPaths: string[]): InspectionTreeRow[] {
  const collapsed = new Set(collapsedPaths);
  return rows.filter((row) => {
    const parts = row.path.split("/");
    for (let index = 1; index < parts.length; index += 1) {
      if (collapsed.has(parts.slice(0, index).join("/"))) {
        return false;
      }
    }
    return true;
  });
}

function getLeftItemIds(model: WorkspaceShellModel): string[] {
  const itemIds: string[] = [];

  for (const repo of model.repos) {
    itemIds.push(`repo:${repo.id}`);
    for (const task of model.tasks.filter((entry) => entry.repoId === repo.id)) {
      itemIds.push(`task:${task.id}`);
    }
    itemIds.push(`new-task:${repo.id}`);
  }

  itemIds.push("new-workspace");
  return itemIds;
}

function resolvePtySessionSpec(model: WorkspaceShellModel, tabId: string, workspaceRoot: string) {
  const task = model.tasks.find((entry) => entry.ptyTabs.some((tab) => tab.id === tabId)) ?? null;
  const tab = task?.ptyTabs.find((entry) => entry.id === tabId) ?? null;

  return {
    cwd: task?.worktreePath ?? workspaceRoot,
    command: tab?.kind === "agent" ? resolveAgentCommand(tab) : [],
  };
}

function resolveAgentCommand(tab: TaskPtyTabRecord): string[] {
  return tab.command.length > 0 ? tab.command : ["codex"];
}

function getRunnerOptionsState(state: Extract<AppState, { mode: "overlay" }>): RunnerOptionsState {
  return state.runnerOptions ?? {
    menuIndex: state.menuIndex,
    message: state.optionsMessage,
  };
}

function resolveNewPtyTabKind(task: TaskRecord, activeTab: string, preferredKind: TaskPtyTabRecord["kind"]): TaskPtyTabRecord["kind"] {
  return task.ptyTabs.find((tab) => tab.id === activeTab)?.kind ?? preferredKind;
}

function createNextPtyTab(
  task: TaskRecord,
  kind: TaskPtyTabRecord["kind"],
  runner?: RunnerType,
  config: CraigConfig = {},
): TaskPtyTabRecord {
  const effectiveRunner = runner ?? task.runner;
  const runnerProfile = getRunnerProfile(effectiveRunner);
  const baseTitle = kind === "agent" ? runnerProfile.defaultAgentTitle : "Terminal";
  const baseId = kind === "agent" && runner && runner !== task.runner
    ? `${task.id}:${runner}`
    : `${task.id}:${kind}`;
  const existingIds = new Set(task.ptyTabs.map((tab) => tab.id));
  let ordinal = 1;
  let id = baseId;

  while (existingIds.has(id)) {
    ordinal += 1;
    id = `${baseId}-${ordinal}`;
  }

  const timestamp = new Date().toISOString();
  const tabRunner = runner && runner !== task.runner ? runner : undefined;
  return {
    id,
    kind,
    ...(tabRunner ? { runner: tabRunner } : {}),
    title: ordinal === 1 ? baseTitle : `${baseTitle} ${ordinal}`,
    command: kind === "agent" ? buildRunnerCommand(effectiveRunner, undefined, config) : [],
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

async function createInteractiveTask(paths: ReturnType<typeof getCraigPaths>, repoId: string, prompt: string, runner: RunnerType): Promise<TaskRecord> {
  const config = await readCraigConfig(paths);
  assertRunnerEnabled(runner, config);
  const provisioned = await provisionTask(paths, repoId, prompt, { runner, config });
  try {
    const env = withDefaultCommandPath();
    await runCommand(requireExecutablePath(getConfiguredRunnerProfile(runner, config).executable, { cwd: provisioned.repoRoot, env }), ["--help"], {
      cwd: provisioned.repoRoot,
      env,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to start runner.";
    const failedTask: TaskRecord = {
      ...provisioned.task,
      status: "draft",
      runnerSession: {
        ...provisioned.task.runnerSession,
        lastKnownState: "failed",
        exitedAt: new Date().toISOString(),
      },
      lastFailureReason: message,
    };
    await writeTask(paths, failedTask);
    throw new InteractiveTaskStartupError(message, failedTask);
  }
  const agentTabId = getRequiredPtyTabId(provisioned.task, "agent");
  const runningTask: TaskRecord = {
    ...provisioned.task,
    status: "running",
    selectedPtyTabId: agentTabId,
    runnerSession: {
      ...provisioned.task.runnerSession,
      startedAt: new Date().toISOString(),
      lastKnownState: "running",
    },
  };

  await writeTask(paths, runningTask);
  await writeUiState(
    { uiStateFile: paths.uiStateFile },
    {
      ...((await readUiState({ uiStateFile: paths.uiStateFile })) ?? getDefaultUiState()),
      version: 1,
      selectedRepoId: runningTask.repoId,
      selectedWorkspaceId: runningTask.workspaceId,
      selectedTaskId: runningTask.id,
      selectedPtyTabId: runningTask.selectedPtyTabId,
      inputMode: "control",
      focusedRegion: "center",
      activeTab: runningTask.selectedPtyTabId ?? "agent",
      selectedActionId: "commit",
      updatedAt: new Date().toISOString(),
    },
  );

  return runningTask;
}

class InteractiveTaskStartupError extends Error {
  readonly task: TaskRecord;

  constructor(message: string, task: TaskRecord) {
    super(message);
    this.name = "InteractiveTaskStartupError";
    this.task = task;
  }
}

function getRequiredPtyTabId(task: TaskRecord, kind: TaskPtyTabRecord["kind"]): string {
  const tab = task.ptyTabs.find((entry) => entry.kind === kind);
  if (!tab) {
    throw new Error(`Task ${task.id} is missing its ${kind} PTY tab.`);
  }

  return tab.id;
}

function getPtySize(viewport: Viewport): PtySize {
  // The center PTY surface reserves:
  // 1. tab strip
  // 2. active-tab underline
  // 3. task header
  // 4. spacer before the PTY surface
  // 5. full-width footer row
  return {
    columns: Math.max(
      20,
      viewport.width -
        SHELL_LAYOUT.leftWidth -
        SHELL_LAYOUT.rightWidth -
        SHELL_LAYOUT.dividerWidth -
        CENTER_TERMINAL_GUTTER * 2,
    ),
    rows: Math.max(5, viewport.height - SHELL_LAYOUT.topRailHeight - 5),
  };
}

function inputToString(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (Buffer.isBuffer(value)) {
    return value.toString("utf8");
  }

  return "";
}

function shouldTrackTerminalKey(key: string): boolean {
  return key.length === 1 || isEnterKey(key) || key === "BACKSPACE" || key === "TAB";
}

function isAgentTabId(tabId: string | null): boolean {
  return typeof tabId === "string" && /:agent(?:-\d+)?$/.test(tabId);
}

function getTerminalScrollLinesForKey(key: string, scrolledBack: boolean): number {
  if (key === "UP" && scrolledBack) {
    return -3;
  }

  if (key === "DOWN" && scrolledBack) {
    return 3;
  }

  if (key === "PAGE_UP") {
    return -5;
  }

  if (key === "PAGE_DOWN") {
    return 5;
  }

  if (key === "MOUSE_WHEEL_UP") {
    return -3;
  }

  if (key === "MOUSE_WHEEL_DOWN") {
    return 3;
  }

  return 0;
}

function getTerminalScrollLinesForMouseEvent(name: unknown): number {
  if (name === "MOUSE_WHEEL_UP") {
    return -3;
  }

  if (name === "MOUSE_WHEEL_DOWN") {
    return 3;
  }

  return 0;
}

function getTerminalScrollLinesForRawInput(raw: string): number {
  const match = new RegExp(`${String.fromCharCode(27)}\\[<(\\d+);\\d+;\\d+[mM]`).exec(raw);
  if (!match?.[1]) {
    return 0;
  }

  const code = Number.parseInt(match[1], 10);
  if (code === 64) {
    return -3;
  }

  if (code === 65) {
    return 3;
  }

  return 0;
}


function shouldSuppressRawTerminalInput(
  suppressTerminalEnterOnAttach: boolean,
  previous: { key: string; at: number } | null,
  raw: string,
): boolean {
  if (raw.length === 0) {
    return false;
  }

  if (suppressTerminalEnterOnAttach && (raw === "\r" || raw === "\n" || raw === "\r\n")) {
    return true;
  }

  if (!previous || Date.now() - previous.at >= 30) {
    return false;
  }

  if (raw === previous.key) {
    return true;
  }

  return raw.length <= 4 && raw.split("").every((char) => char === previous.key);
}

async function loadWorkspaceBrowser(rootPath: string): Promise<WorkspaceBrowserState> {
  const directoryEntries = await readdir(rootPath, { withFileTypes: true });
  const entries: WorkspaceBrowserEntry[] = [];

  for (const entry of directoryEntries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const entryPath = path.join(rootPath, entry.name);
    entries.push({
      name: entry.name,
      path: entryPath,
      kind: (await isGitRepoDirectory(entryPath)) ? "repo" : "directory",
    });
  }

  entries.sort((left, right) => {
    if (left.kind !== right.kind) {
      return left.kind === "repo" ? -1 : 1;
    }

    return left.name.localeCompare(right.name);
  });

  return {
    cwd: rootPath,
    entries,
    selectedIndex: 0,
    error: null,
  };
}

async function isGitRepoDirectory(rootPath: string): Promise<boolean> {
  const gitPath = path.join(rootPath, ".git");
  const stats = await stat(gitPath).catch(() => null);
  return stats !== null;
}
