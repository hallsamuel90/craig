import { getDefaultUiState } from "../state/ui-state-store.js";
import type { CraigConfig } from "../types/config.js";
import type { RunnerType, TaskPtyTabKind, TaskRecord } from "../types/task.js";
import type { RepoRecord } from "../types/workspace.js";
import type { WorkspaceRecord } from "../types/workspace.js";
import type { CraigUiRuntime } from "../types/workspace.js";
import { RUNNER_IDS, getDefaultRunner, getEnabledRunnerIds, isRunnerType } from "../services/runner-profiles.js";
import type { TerminalScreenRow } from "./terminal-emulator.js";

export const FOCUS_REGIONS = ["tasks", "center", "inspector", "actions"] as const;
export const LEGACY_PTY_SURFACE_IDS = ["agent", "terminal"] as const;
export const FIXED_CENTER_TAB_IDS = [] as const;
export const INSPECTION_TAB_ID = "inspection";
export const CENTER_TAB_IDS = [...LEGACY_PTY_SURFACE_IDS, ...FIXED_CENTER_TAB_IDS] as const;
export const ACTION_IDS = ["commit", "push", "refresh-checks", "close-task"] as const;
const REVIEW_ACTION_IDS = ["refresh-checks", "close-task"] as const;
export const INSPECTOR_SECTION_IDS = ["task", "checks", "pr", "setup-run", "actions", "next-action"] as const;
export const INSPECTION_MODE_IDS = ["diff", "files", "review"] as const;

export type InputMode = "control" | "terminal";
export type FocusRegion = (typeof FOCUS_REGIONS)[number];
export type CenterTabId = string;
export type FixedCenterTabId = (typeof FIXED_CENTER_TAB_IDS)[number];
export type InspectionMode = (typeof INSPECTION_MODE_IDS)[number];
export type OpenInspectionKind = "file" | "diff";
export type ActionId = (typeof ACTION_IDS)[number];
export type InspectorSectionId = (typeof INSPECTOR_SECTION_IDS)[number];
export type TerminalStatus = "idle" | "running" | "exited" | "failed";
export type LeftNavItemId = string;

export interface WorkspaceBrowserEntry {
  name: string;
  path: string;
  kind: "directory" | "repo";
}

export interface WorkspaceBrowserState {
  cwd: string;
  entries: WorkspaceBrowserEntry[];
  selectedIndex: number;
  error: string | null;
}

export interface TerminalViewState {
  status: TerminalStatus;
  rows: TerminalScreenRow[];
  error: string | null;
  scrolledBack?: boolean;
}

export interface ControlShellState {
  inputMode: InputMode;
  focusedRegion: FocusRegion;
  selectedRepoId: string | null;
  selectedWorkspaceId: string | null;
  selectedTaskId: string | null;
  selectedPtyTabId: string | null;
  selectedLeftItemId: LeftNavItemId | null;
  activeTab: CenterTabId;
  preferredPtyTabKind: TaskPtyTabKind;
  inspectorSection: InspectorSectionId;
  inspectionMode: InspectionMode;
  openInspectionKind: OpenInspectionKind | null;
  selectedFileTreePath: string | null;
  selectedFilePath: string | null;
  selectedDiffPath: string | null;
  collapsedFileTreePaths: string[];
  fileScrollOffset: number;
  diffScrollOffset: number;
  reviewScrollOffset: number;
  selectedActionId: ActionId;
  selectedProjectTargetId: string | null;
  selectedRunner: RunnerType;
  centerTabRunner: RunnerType | null;
  actionMessage: string | null;
  footerToast: string | null;
  taskPromptInput: string | null;
  taskPromptError: string | null;
  workspaceBrowser: WorkspaceBrowserState | null;
  terminal: TerminalViewState;
  centerZoomed: boolean;
}

export interface ReduceMainKeyOptions {
  leftItemIds: LeftNavItemId[];
  centerTabIds?: CenterTabId[];
  ptyTabIds?: string[];
  filePathIds?: string[];
  fileTreeRowIds?: string[];
  fileTreeFileIds?: string[];
  fileTreeDirectoryIds?: string[];
  diffPathIds?: string[];
  diffPathRanges?: Array<{ path: string; start: number; end: number }>;
  fileLineCount?: number;
  diffLineCount?: number;
  reviewRowCount?: number;
  pageRows?: number;
  enabledRunnerIds?: RunnerType[];
  projectTargetIds?: string[];
}

export interface MainKeyResult {
  state: ControlShellState;
  changed: boolean;
  exit: boolean;
  pause: boolean;
  attachTerminal: boolean;
  detachTerminal: boolean;
  beginTaskPrompt: boolean;
  openWorkspaceBrowser: boolean;
  createWorkspaceTask: boolean;
  createPtyTab: boolean;
  createPtyTabKind: TaskPtyTabKind | null;
  createPtyTabRunner: RunnerType | null;
  closePtyTab: boolean;
  refreshPullRequestChecks: boolean;
  closeTask: boolean;
  removeWorkspace: boolean;
  refreshInspection: boolean;
}

export interface RestoreShellModel {
  workspaces?: WorkspaceRecord[];
  repos: RepoRecord[];
  tasks: TaskRecord[];
  inspection?: {
    taskId: string;
    selectedFilePath: string | null;
    selectedDiffPath: string | null;
    filePaths?: string[];
    diffPaths?: string[];
    fileRows?: Array<{ kind: string; path: string }>;
  } | null;
}

export interface RestoreShellStateOptions {
  resetInputMode?: boolean;
}

export function createInitialShellState(runtime: CraigUiRuntime | null, config: CraigConfig = {}): ControlShellState {
  const legacyInspectionKind = runtime?.activeTab === "files" ? "file" : runtime?.activeTab === "diff" ? "diff" : null;
  const openInspectionKind = getValidOpenInspectionKind(runtime?.openInspectionKind) ?? legacyInspectionKind;
  const enabledRunnerIds = getEnabledRunnerIds(config);
  return {
    inputMode: getValidInputMode(runtime?.inputMode),
    focusedRegion: getValidFocusRegion(runtime?.focusedRegion),
    selectedRepoId: optionalString(runtime?.selectedRepoId),
    selectedWorkspaceId: optionalString(runtime?.selectedWorkspaceId),
    selectedTaskId: optionalString(runtime?.selectedTaskId),
    selectedPtyTabId: optionalString(runtime?.selectedPtyTabId),
    selectedLeftItemId: buildSelectedTaskLeftItemId(optionalString(runtime?.selectedTaskId)),
    activeTab: legacyInspectionKind ? INSPECTION_TAB_ID : optionalString(runtime?.activeTab) ?? "agent",
    preferredPtyTabKind: getValidPtyTabKind(runtime?.preferredPtyTabKind),
    inspectorSection: getValidValue(runtime?.inspectorSection, INSPECTOR_SECTION_IDS, "task"),
    inspectionMode: getValidInspectionMode(runtime?.inspectionMode, legacyInspectionKind === "diff" ? "diff" : "files"),
    openInspectionKind,
    selectedFileTreePath: optionalString(runtime?.selectedFileTreePath),
    selectedFilePath: optionalString(runtime?.selectedFilePath),
    selectedDiffPath: optionalString(runtime?.selectedDiffPath),
    collapsedFileTreePaths: Array.isArray(runtime?.collapsedFileTreePaths) ? runtime.collapsedFileTreePaths : [],
    fileScrollOffset: 0,
    diffScrollOffset: 0,
    reviewScrollOffset: 0,
    selectedActionId: getValidValue(runtime?.selectedActionId, ACTION_IDS, "commit"),
    selectedProjectTargetId: null,
    selectedRunner: getValidRunner(runtime?.selectedRunner, enabledRunnerIds, getDefaultRunner(config)),
    centerTabRunner: null,
    actionMessage: null,
    footerToast: null,
    taskPromptInput: null,
    taskPromptError: null,
    workspaceBrowser: null,
    terminal: createDefaultTerminalViewState(),
    centerZoomed: false,
  };
}

export function createDefaultTerminalViewState(): TerminalViewState {
  return {
    status: "idle",
    rows: [],
    error: null,
    scrolledBack: false,
  };
}

export function toPersistedUiState(runtime: CraigUiRuntime | null, state: ControlShellState): CraigUiRuntime {
  return {
    ...(runtime ?? getDefaultUiState()),
    selectedRepoId: state.selectedRepoId,
    selectedWorkspaceId: state.selectedWorkspaceId,
    selectedTaskId: state.selectedTaskId,
    selectedPtyTabId: state.selectedPtyTabId,
    inputMode: state.inputMode,
    focusedRegion: state.focusedRegion,
    activeTab: state.activeTab,
    preferredPtyTabKind: state.preferredPtyTabKind,
    inspectorSection: state.inspectorSection,
    inspectionMode: state.inspectionMode,
    openInspectionKind: state.openInspectionKind,
    selectedFileTreePath: state.selectedFileTreePath,
    selectedFilePath: state.selectedFilePath,
    selectedDiffPath: state.selectedDiffPath,
    collapsedFileTreePaths: state.collapsedFileTreePaths,
    selectedActionId: state.selectedActionId,
    selectedRunner: state.selectedRunner,
  };
}

export function restoreShellState(
  state: ControlShellState,
  model: RestoreShellModel,
  options: RestoreShellStateOptions = {},
): ControlShellState {
  const selectedLeftItemId = resolveLeftItemId(state, model);
  const leftSelection = parseLeftItemId(selectedLeftItemId);
  const selectedWorkspace =
    (leftSelection?.kind === "workspace" ? model.workspaces?.find((workspace) => workspace.id === leftSelection.id) ?? null : null) ??
    (leftSelection?.kind === "task"
      ? model.workspaces?.find((workspace) => workspace.id === model.tasks.find((task) => task.id === leftSelection.id)?.workspaceId) ?? null
      : null) ??
    model.workspaces?.find((workspace) => workspace.id === state.selectedWorkspaceId) ??
    model.workspaces?.[0] ??
    null;
  const selectedRepo =
    (leftSelection?.kind === "repo"
      ? model.repos.find((repo) => repo.id === leftSelection.id) ?? null
      : leftSelection?.kind === "task"
        ? model.repos.find((repo) => repo.id === model.tasks.find((task) => task.id === leftSelection.id)?.repoId) ?? null
        : null) ??
    (selectedWorkspace?.kind === "project"
      ? model.repos.find((repo) => repo.id === state.selectedRepoId && selectedWorkspace.discoveredRepoIds?.includes(repo.id)) ?? null
      : null) ??
    (selectedWorkspace?.kind !== "project" ? model.repos.find((repo) => repo.id === selectedWorkspace?.primaryRepoId) ?? null : null) ??
    model.repos.find((repo) => repo.id === state.selectedRepoId) ??
    model.repos[0] ??
    null;
  const repoId = selectedRepo?.id ?? null;
  const repoTasks = selectedWorkspace
    ? model.tasks.filter((task) => task.workspaceId === selectedWorkspace.id)
    : repoId
      ? model.tasks.filter((task) => task.repoId === repoId)
      : [];
  const selectedTask =
    (leftSelection?.kind === "task" ? repoTasks.find((task) => task.id === leftSelection.id) ?? null : null) ??
    repoTasks.find((task) => task.id === state.selectedTaskId) ??
    repoTasks[0] ??
    null;

  return {
    ...state,
    inputMode: options.resetInputMode ? "control" : state.inputMode,
    selectedLeftItemId,
    selectedWorkspaceId: selectedWorkspace?.id ?? null,
    selectedRepoId: repoId,
    selectedTaskId: selectedTask?.id ?? null,
    ...resolveTaskTabs(selectedTask, state.activeTab, state.selectedPtyTabId),
    selectedFilePath: resolveSelectedFilePath(state, model, selectedTask?.id ?? null),
    ...resolveFileTreeState(state, model, selectedTask?.id ?? null),
    selectedDiffPath: resolveSelectedDiffPath(state, model, selectedTask?.id ?? null),
    inspectorSection: getValidValue(state.inspectorSection, INSPECTOR_SECTION_IDS, "task"),
  };
}

export function reduceMainKey(state: ControlShellState, key: string, options: ReduceMainKeyOptions = { leftItemIds: [] }): MainKeyResult {
  if (state.inputMode === "terminal") {
    if (isTerminalDetachKey(key)) {
      return result({
        state: { ...state, inputMode: "control", centerZoomed: false, actionMessage: null, focusedRegion: "center" },
        changed: true,
        detachTerminal: true,
      });
    }

    return result({ state });
  }

  if (key === "q" || key === "Q") {
    return result({ state, exit: true });
  }

  if (key === "ESCAPE") {
    return result({ state: { ...state, actionMessage: null }, changed: state.actionMessage !== null, pause: true });
  }

  if (key === "n" || key === "N") {
    return result({
      state: {
        ...state,
        focusedRegion: "tasks",
        actionMessage: null,
        taskPromptInput: "",
        taskPromptError: null,
      },
      changed: true,
      beginTaskPrompt: true,
    });
  }

  if ((key === "r" || key === "R") && state.focusedRegion === "tasks" && (isNewTaskLeftItemId(state.selectedLeftItemId) || isNewTaskWorkspaceLeftItemId(state.selectedLeftItemId))) {
    return result({
      state: {
        ...state,
        selectedRunner: getNextRunner(state.selectedRunner, options.enabledRunnerIds),
        actionMessage: null,
        taskPromptError: null,
      },
      changed: true,
    });
  }

  if (key === "TAB" || key === "]") {
    return updateFocus(state, 1);
  }

  if (key === "SHIFT_TAB" || key === "[") {
    return updateFocus(state, -1);
  }

  if (key === "z" || key === "Z") {
    return result({
      state: { ...state, centerZoomed: !state.centerZoomed, actionMessage: null },
      changed: true,
    });
  }

  if (key === "UP" || key === "k") {
    if (state.focusedRegion === "center" && state.activeTab === INSPECTION_TAB_ID) {
      return scrollInspectionContent(state, -1, options);
    }

    return moveSelection(state, -1, options);
  }

  if (key === "DOWN" || key === "j") {
    if (state.focusedRegion === "center" && state.activeTab === INSPECTION_TAB_ID) {
      return scrollInspectionContent(state, 1, options);
    }

    return moveSelection(state, 1, options);
  }

  if (key === "PAGE_UP") {
    return scrollInspectionContent(state, -(options.pageRows ?? 10), options);
  }

  if (key === "PAGE_DOWN") {
    return scrollInspectionContent(state, options.pageRows ?? 10, options);
  }

  if (key === "MOUSE_WHEEL_UP") {
    return scrollInspectionContent(state, -3, options);
  }

  if (key === "MOUSE_WHEEL_DOWN") {
    return scrollInspectionContent(state, 3, options);
  }

  if (key === "r" && state.focusedRegion === "center" && state.selectedTaskId) {
    const runners = options.enabledRunnerIds ?? (RUNNER_IDS as readonly RunnerType[]);
    const currentIndex = state.centerTabRunner ? runners.indexOf(state.centerTabRunner) : -1;
    const nextRunner: RunnerType | null = currentIndex === runners.length - 1 ? null : runners[currentIndex + 1]!;
    return result({
      state: { ...state, centerTabRunner: nextRunner, actionMessage: null },
      changed: true,
    });
  }

  if ((key === "+" || key === "a" || key === "A" || key === "t" || key === "T") && state.focusedRegion === "center" && state.selectedTaskId) {
    const kind = getCreatePtyTabKind(state, key);
    return result({
      state: { ...state, preferredPtyTabKind: kind, actionMessage: null },
      changed: true,
      createPtyTab: true,
      createPtyTabKind: kind,
      createPtyTabRunner: kind === "agent" ? state.centerTabRunner : null,
    });
  }

  if ((key === "R" || key === "r") && state.focusedRegion === "inspector" && state.inspectionMode === "review") {
    return result({
      state: { ...state, selectedActionId: "refresh-checks", actionMessage: null },
      changed: true,
      refreshPullRequestChecks: true,
    });
  }

  if ((key === "X" || key === "x") && state.focusedRegion === "inspector" && state.inspectionMode === "review") {
    return result({
      state: { ...state, selectedActionId: "close-task", actionMessage: null },
      changed: true,
      closeTask: true,
    });
  }

  if ((key === "X" || key === "x") && state.focusedRegion === "tasks" && isTaskLeftItemId(state.selectedLeftItemId) && state.selectedTaskId) {
    return result({
      state: { ...state, selectedActionId: "close-task", actionMessage: null },
      changed: true,
      closeTask: true,
    });
  }

  if ((key === "X" || key === "x") && state.focusedRegion === "tasks" && isWorkspaceLeftItemId(state.selectedLeftItemId) && state.selectedWorkspaceId) {
    return result({
      state: { ...state, actionMessage: null },
      changed: true,
      removeWorkspace: true,
    });
  }

  if (key === "x" && state.focusedRegion === "center" && isConcretePtyTab(state.activeTab, options.ptyTabIds ?? [])) {
    return result({ state: { ...state, actionMessage: null }, changed: true, closePtyTab: true });
  }

  if (key === "LEFT" || key === "h") {
    if (state.focusedRegion === "center") {
      return moveTab(state, -1, options.centerTabIds);
    }
    if (state.focusedRegion === "inspector") {
      return moveInspectionMode(state, -1);
    }
  }

  if (key === "RIGHT" || key === "l") {
    if (state.focusedRegion === "center") {
      return moveTab(state, 1, options.centerTabIds);
    }
    if (state.focusedRegion === "inspector") {
      return moveInspectionMode(state, 1);
    }
  }

  if (isEnterKey(key)) {
    if (state.focusedRegion === "tasks" && (isNewTaskLeftItemId(state.selectedLeftItemId) || isNewTaskWorkspaceLeftItemId(state.selectedLeftItemId))) {
      const repoId = getNewTaskRepoId(state.selectedLeftItemId);
      const workspaceId = getNewTaskWorkspaceId(state.selectedLeftItemId);
      return result({
        state: {
          ...state,
          selectedRepoId: repoId ?? state.selectedRepoId,
          selectedWorkspaceId: workspaceId ?? state.selectedWorkspaceId,
          actionMessage: null,
          taskPromptInput: "",
          taskPromptError: null,
        },
        changed: true,
        beginTaskPrompt: true,
      });
    }

    if (state.focusedRegion === "tasks" && state.selectedLeftItemId === "new-workspace") {
      return result({
        state: {
          ...state,
          actionMessage: null,
        },
        changed: true,
        openWorkspaceBrowser: true,
      });
    }

    if (state.focusedRegion === "tasks" && isTaskLeftItemId(state.selectedLeftItemId) && state.selectedTaskId) {
      const tabId = state.selectedPtyTabId ?? state.activeTab;
      return result({
        state: {
          ...state,
          inputMode: "terminal",
          focusedRegion: "center",
          activeTab: tabId,
          selectedPtyTabId: tabId,
          preferredPtyTabKind: getPtyTabKindFromId(tabId) ?? state.preferredPtyTabKind,
          actionMessage: null,
        },
        changed: true,
        attachTerminal: true,
      });
    }

    if (state.focusedRegion === "center" && isConcretePtyTab(state.activeTab, options.ptyTabIds ?? []) && state.selectedTaskId) {
      return result({
        state: {
          ...state,
          inputMode: "terminal",
          selectedPtyTabId: state.activeTab,
          preferredPtyTabKind: getPtyTabKindFromId(state.activeTab) ?? state.preferredPtyTabKind,
          actionMessage: null,
        },
        changed: true,
        attachTerminal: true,
      });
    }

    if (state.focusedRegion === "center" && state.activeTab === INSPECTION_TAB_ID) {
      return result({
        state: { ...state, actionMessage: null },
        changed: true,
        refreshInspection: true,
      });
    }

    if (state.focusedRegion === "inspector" && state.selectedTaskId && state.inspectionMode === "files") {
      const selectedTreePath = state.selectedFileTreePath ?? state.selectedFilePath;
      if (selectedTreePath && (options.fileTreeDirectoryIds ?? []).includes(selectedTreePath)) {
        return result({
          state: toggleCollapsedFileTreePath({ ...state, selectedFileTreePath: selectedTreePath }),
          changed: true,
        });
      }

      const selectedFilePath = selectedTreePath && (options.fileTreeFileIds ?? []).includes(selectedTreePath)
        ? selectedTreePath
        : state.selectedFilePath;
      return result({
        state: {
          ...state,
          selectedFileTreePath: selectedFilePath,
          selectedFilePath,
          activeTab: INSPECTION_TAB_ID,
          openInspectionKind: "file",
          fileScrollOffset: 0,
          actionMessage: null,
        },
        changed: true,
        refreshInspection: true,
      });
    }

    if (state.focusedRegion === "inspector" && state.selectedTaskId && state.inspectionMode === "diff") {
      return result({
        state: {
          ...state,
          activeTab: INSPECTION_TAB_ID,
          openInspectionKind: "diff",
          diffScrollOffset: 0,
          actionMessage: null,
        },
        changed: true,
        refreshInspection: true,
      });
    }

    if (state.focusedRegion === "inspector" && state.inspectionMode === "review") {
      if (state.selectedActionId === "refresh-checks") {
        return result({
          state: {
            ...state,
            actionMessage: null,
          },
          changed: true,
          refreshPullRequestChecks: true,
        });
      }

      if (state.selectedActionId === "close-task") {
        return result({
          state: {
            ...state,
            actionMessage: null,
          },
          changed: true,
          closeTask: true,
        });
      }

      return result({
        state: {
          ...state,
          selectedActionId: "refresh-checks",
          actionMessage: null,
        },
        changed: true,
        refreshPullRequestChecks: true,
      });
    }

    if (state.focusedRegion !== "actions") {
      return result({ state });
    }

    if (state.selectedActionId === "refresh-checks") {
      return result({
        state: {
          ...state,
          actionMessage: null,
        },
        changed: true,
        refreshPullRequestChecks: true,
      });
    }

    if (state.selectedActionId === "close-task") {
      return result({
        state: {
          ...state,
          actionMessage: null,
        },
        changed: true,
        closeTask: true,
      });
    }

    return result({
      state: {
        ...state,
        actionMessage: `Action queued: ${state.selectedActionId} (inspection surfaces land in phase 4.1).`,
      },
      changed: true,
    });
  }

  return result({ state });
}

export function updateTerminalViewState(state: ControlShellState, terminal: TerminalViewState): ControlShellState {
  return {
    ...state,
    terminal,
  };
}

export function markTerminalAttachFailed(state: ControlShellState, message: string): ControlShellState {
  return {
    ...state,
    inputMode: "control",
    terminal: {
      status: "failed",
      rows: [],
      error: message,
    },
  };
}

export function isTerminalDetachKey(key: string): boolean {
  return key === "\u001D" || key === "CTRL_]" || key === "CTRL_RIGHT_BRACKET";
}

export function isEnterKey(key: string): boolean {
  return key === "ENTER" || key === "KP_ENTER" || key === "RETURN" || key === "CTRL_M" || key === "\r" || key === "\n";
}

export function isPrintableKey(key: string): boolean {
  return key.length === 1 && key >= " " && key !== "\u007f";
}

export function isPtyTab(tabId: CenterTabId): boolean {
  return isLegacyPtySurface(tabId) || getPtyTabKindFromId(tabId) !== null;
}

export function isFixedCenterTab(tabId: string): tabId is FixedCenterTabId {
  return (FIXED_CENTER_TAB_IDS as readonly string[]).includes(tabId);
}

export function isLegacyPtySurface(tabId: string): tabId is (typeof LEGACY_PTY_SURFACE_IDS)[number] {
  return (LEGACY_PTY_SURFACE_IDS as readonly string[]).includes(tabId);
}

export function buildCenterTabIds(task: TaskRecord | null, state?: Pick<ControlShellState, "openInspectionKind">): CenterTabId[] {
  return [
    ...(task?.ptyTabs.map((tab) => tab.id) ?? []),
    ...(state?.openInspectionKind ? [INSPECTION_TAB_ID] : []),
  ];
}

const NAVIGABLE_FOCUS_REGIONS: FocusRegion[] = ["tasks", "center", "inspector"];

function updateFocus(state: ControlShellState, direction: -1 | 1): MainKeyResult {
  return updateIndexedValue(state, "focusedRegion", NAVIGABLE_FOCUS_REGIONS, direction);
}

function moveTab(state: ControlShellState, direction: -1 | 1, centerTabIds: CenterTabId[] | undefined): MainKeyResult {
  const next = updateIndexedValue(
    state,
    "activeTab",
    centerTabIds && centerTabIds.length > 0 ? centerTabIds : buildCenterTabIdsFromState(state),
    direction,
  );
  if (!next.changed) {
    return next;
  }

  if (isFixedCenterTab(next.state.activeTab)) {
    return next;
  }

  return {
    ...next,
    state: {
      ...next.state,
      selectedPtyTabId: next.state.activeTab,
      preferredPtyTabKind: getPtyTabKindFromId(next.state.activeTab) ?? next.state.preferredPtyTabKind,
    },
  };
}

function moveSelection(state: ControlShellState, direction: -1 | 1, options: ReduceMainKeyOptions): MainKeyResult {
  if (state.focusedRegion === "tasks") {
    return moveLeftSelection(state, direction, options.leftItemIds);
  }

  if (state.focusedRegion === "center") {
    return moveTab(state, direction, options.centerTabIds);
  }

  if (state.focusedRegion === "inspector") {
    if (state.inspectionMode === "files") {
      return moveFileTreeSelection(state, direction, options);
    }

    if (state.inspectionMode === "diff") {
      const next = updateDynamicValue(state, "selectedDiffPath", options.diffPathIds ?? [], direction, true);
      return next.changed
        ? {
            ...next,
            state: {
              ...next.state,
              activeTab: INSPECTION_TAB_ID,
              openInspectionKind: "diff",
              diffScrollOffset: 0,
            },
            refreshInspection: true,
          }
        : next;
    }

    if (options.projectTargetIds?.length) {
      const next = updateDynamicValue(state, "selectedProjectTargetId", options.projectTargetIds, direction);
      return next.changed ? { ...next, state: { ...next.state, reviewScrollOffset: 0 } } : next;
    }
    return updateIndexedValue(state, "selectedActionId", REVIEW_ACTION_IDS, direction);
  }

  return updateIndexedValue(state, "selectedActionId", ACTION_IDS, direction);
}

function moveLeftSelection(state: ControlShellState, direction: -1 | 1, leftItemIds: LeftNavItemId[]): MainKeyResult {
  const next = updateDynamicValue(state, "selectedLeftItemId", leftItemIds, direction);
  if (!next.changed) {
    return next;
  }

  const selection = parseLeftItemId(next.state.selectedLeftItemId);
  if (selection?.kind === "workspace") {
    return {
      ...next,
      state: {
        ...next.state,
        selectedWorkspaceId: selection.id,
        selectedTaskId: null,
        selectedPtyTabId: null,
        selectedFilePath: null,
        selectedFileTreePath: null,
        selectedDiffPath: null,
        fileScrollOffset: 0,
        diffScrollOffset: 0,
        reviewScrollOffset: 0,
      },
      refreshInspection: true,
    };
  }
  if (selection?.kind === "task") {
    return {
      ...next,
      state: {
        ...next.state,
        selectedTaskId: selection.id,
        selectedFilePath: null,
        selectedFileTreePath: null,
        selectedDiffPath: null,
        fileScrollOffset: 0,
        diffScrollOffset: 0,
        reviewScrollOffset: 0,
      },
      refreshInspection: true,
    };
  }

  if (selection?.kind === "repo") {
    return {
      ...next,
      state: {
        ...next.state,
        selectedRepoId: selection.id,
        selectedTaskId: null,
        selectedPtyTabId: null,
        selectedFilePath: null,
        selectedFileTreePath: null,
        selectedDiffPath: null,
        fileScrollOffset: 0,
        diffScrollOffset: 0,
        reviewScrollOffset: 0,
      },
      refreshInspection: true,
    };
  }

  const newTaskRepoId = getNewTaskRepoId(next.state.selectedLeftItemId);
  if (newTaskRepoId) {
    return {
      ...next,
      state: {
        ...next.state,
        selectedRepoId: newTaskRepoId,
      },
    };
  }

  const newTaskWorkspaceId = getNewTaskWorkspaceId(next.state.selectedLeftItemId);
  if (newTaskWorkspaceId) {
    return {
      ...next,
      state: {
        ...next.state,
        selectedWorkspaceId: newTaskWorkspaceId,
      },
    };
  }

  return next;
}

export function scrollInspectionContent(state: ControlShellState, delta: number, options: ReduceMainKeyOptions): MainKeyResult {
  if (delta === 0) {
    return result({ state });
  }

  if (state.focusedRegion === "inspector") {
    if (state.inspectionMode === "files") {
      return moveFileTreeSelection(state, delta, options);
    }

    if (state.inspectionMode === "diff") {
      const next = updateDynamicValue(state, "selectedDiffPath", options.diffPathIds ?? [], delta, true);
      return next.changed ? { ...next, state: { ...next.state, diffScrollOffset: 0 } } : next;
    }

    if (state.inspectionMode === "review") {
      return updateScrollOffset(state, "reviewScrollOffset", delta, options.reviewRowCount ?? 100, options.pageRows);
    }

    return result({ state });
  }

  if (state.focusedRegion === "center" && state.activeTab === INSPECTION_TAB_ID) {
    if (state.openInspectionKind === "file") {
      return updateScrollOffset(state, "fileScrollOffset", delta, options.fileLineCount ?? 0, options.pageRows);
    }

    if (state.openInspectionKind === "diff") {
      return scrollDiffContent(state, delta, options);
    }
  }

  return result({ state });
}

function setInspectionMode(state: ControlShellState, mode: InspectionMode): MainKeyResult {
  if (state.inspectionMode === mode) {
    return result({ state });
  }

  const openInspectionKind = mode === "diff" ? "diff" : mode === "files" ? "file" : state.openInspectionKind;
  const activeTab = mode === "diff" || mode === "files" ? INSPECTION_TAB_ID : state.activeTab;

  return result({
    state: {
      ...state,
      inspectionMode: mode,
      activeTab,
      openInspectionKind,
      fileScrollOffset: mode === "files" ? 0 : state.fileScrollOffset,
      diffScrollOffset: mode === "diff" ? 0 : state.diffScrollOffset,
      reviewScrollOffset: mode === "review" ? 0 : state.reviewScrollOffset,
      actionMessage: null,
    },
    changed: true,
    refreshInspection: true,
  });
}

function moveInspectionMode(state: ControlShellState, direction: -1 | 1): MainKeyResult {
  return setInspectionMode(
    state,
    updateValueInList(state.inspectionMode, INSPECTION_MODE_IDS, direction),
  );
}

function moveFileTreeSelection(state: ControlShellState, delta: number, options: ReduceMainKeyOptions): MainKeyResult {
  const rowIds = options.fileTreeRowIds && options.fileTreeRowIds.length > 0 ? options.fileTreeRowIds : options.filePathIds ?? [];
  if (rowIds.length === 0) {
    return result({ state });
  }

  const currentPath = state.selectedFileTreePath ?? state.selectedFilePath ?? rowIds[0] ?? null;
  const currentIndex = rowIds.indexOf(currentPath ?? "");
  const nextIndex = clamp(currentIndex === -1 ? 0 : currentIndex + delta, 0, rowIds.length - 1);
  const nextPath = rowIds[nextIndex] ?? null;
  if (nextPath === state.selectedFileTreePath) {
    return result({ state });
  }

  const isFile = nextPath !== null && (options.fileTreeFileIds ?? options.filePathIds ?? []).includes(nextPath);
  return result({
    state: {
      ...state,
      selectedFileTreePath: nextPath,
      selectedFilePath: isFile ? nextPath : state.selectedFilePath,
      activeTab: isFile ? INSPECTION_TAB_ID : state.activeTab,
      openInspectionKind: isFile ? "file" : state.openInspectionKind,
      fileScrollOffset: isFile ? 0 : state.fileScrollOffset,
      actionMessage: null,
    },
    changed: true,
    refreshInspection: isFile,
  });
}

function toggleCollapsedFileTreePath(state: ControlShellState): ControlShellState {
  if (!state.selectedFileTreePath) {
    return state;
  }

  const collapsed = new Set(state.collapsedFileTreePaths);
  if (collapsed.has(state.selectedFileTreePath)) {
    collapsed.delete(state.selectedFileTreePath);
  } else {
    collapsed.add(state.selectedFileTreePath);
  }

  return {
    ...state,
    collapsedFileTreePaths: [...collapsed].sort((left, right) => left.localeCompare(right)),
    actionMessage: null,
  };
}

function updateScrollOffset(
  state: ControlShellState,
  key: "fileScrollOffset" | "diffScrollOffset" | "reviewScrollOffset",
  delta: number,
  lineCount: number,
  visibleRows = 10,
): MainKeyResult {
  const maxOffset = Math.max(0, lineCount - Math.max(1, visibleRows));
  const nextOffset = clamp(state[key] + delta, 0, maxOffset);

  if (nextOffset === state[key]) {
    return result({ state });
  }

  return result({
    state: { ...state, [key]: nextOffset, actionMessage: null },
    changed: true,
  });
}

function scrollDiffContent(state: ControlShellState, delta: number, options: ReduceMainKeyOptions): MainKeyResult {
  if (options.diffPathRanges && options.diffPathRanges.length > 0) {
    return scrollCombinedDiffContent(state, delta, options);
  }

  const lineCount = options.diffLineCount ?? 0;
  const visibleRows = options.pageRows ?? 10;
  const maxOffset = Math.max(0, lineCount - Math.max(1, visibleRows));
  const targetOffset = state.diffScrollOffset + delta;

  const diffPathIds = options.diffPathIds ?? [];
  if (diffPathIds.length === 0 || !state.selectedDiffPath) {
    const nextOffset = clamp(targetOffset, 0, maxOffset);
    return nextOffset === state.diffScrollOffset
      ? result({ state })
      : result({
          state: { ...state, diffScrollOffset: nextOffset, actionMessage: null },
          changed: true,
        });
  }

  const currentIndex = diffPathIds.indexOf(state.selectedDiffPath);
  if (currentIndex === -1) {
    const nextOffset = clamp(targetOffset, 0, maxOffset);
    return nextOffset === state.diffScrollOffset
      ? result({ state })
      : result({
          state: { ...state, diffScrollOffset: nextOffset, actionMessage: null },
          changed: true,
        });
  }

  if (delta > 0 && targetOffset > maxOffset) {
    const nextPath = diffPathIds[currentIndex + 1] ?? null;
    if (!nextPath) {
      return state.diffScrollOffset === maxOffset
        ? result({ state })
        : result({
            state: { ...state, diffScrollOffset: maxOffset, actionMessage: null },
            changed: true,
          });
    }

    return result({
      state: { ...state, selectedDiffPath: nextPath, activeTab: INSPECTION_TAB_ID, openInspectionKind: "diff", diffScrollOffset: 0, actionMessage: null },
      changed: true,
      refreshInspection: true,
    });
  }

  if (delta < 0 && targetOffset < 0) {
    const previousPath = diffPathIds[currentIndex - 1] ?? null;
    if (!previousPath) {
      return state.diffScrollOffset === 0
        ? result({ state })
        : result({
            state: { ...state, diffScrollOffset: 0, actionMessage: null },
            changed: true,
          });
    }

    return result({
      state: {
        ...state,
        selectedDiffPath: previousPath,
        activeTab: INSPECTION_TAB_ID,
        openInspectionKind: "diff",
        diffScrollOffset: Number.MAX_SAFE_INTEGER,
        actionMessage: null,
      },
      changed: true,
      refreshInspection: true,
    });
  }

  const nextOffset = clamp(targetOffset, 0, maxOffset);
  return nextOffset === state.diffScrollOffset
    ? result({ state })
    : result({
        state: { ...state, diffScrollOffset: nextOffset, actionMessage: null },
        changed: true,
      });
}

function scrollCombinedDiffContent(state: ControlShellState, delta: number, options: ReduceMainKeyOptions): MainKeyResult {
  const lineCount = options.diffLineCount ?? 0;
  const visibleRows = options.pageRows ?? 10;
  const maxOffset = Math.max(0, lineCount - Math.max(1, visibleRows));
  const nextOffset = clamp(state.diffScrollOffset + delta, 0, maxOffset);
  const nextPath = resolveDiffPathForOffset(options.diffPathRanges ?? [], nextOffset) ?? state.selectedDiffPath;

  if (nextOffset === state.diffScrollOffset && nextPath === state.selectedDiffPath) {
    return result({ state });
  }

  return result({
    state: {
      ...state,
      diffScrollOffset: nextOffset,
      selectedDiffPath: nextPath,
      actionMessage: null,
    },
    changed: true,
  });
}

function resolveSelectedDiffPath(
  state: ControlShellState,
  model: RestoreShellModel,
  selectedTaskId: string | null,
): string | null {
  if (!model.inspection || model.inspection.taskId !== selectedTaskId) {
    return state.selectedDiffPath;
  }

  if (state.selectedDiffPath && (model.inspection.diffPaths ?? []).includes(state.selectedDiffPath)) {
    return state.selectedDiffPath;
  }

  return model.inspection.selectedDiffPath;
}

function resolveSelectedFilePath(
  state: ControlShellState,
  model: RestoreShellModel,
  selectedTaskId: string | null,
): string | null {
  if (!model.inspection || model.inspection.taskId !== selectedTaskId) {
    return state.selectedFilePath;
  }

  if (state.selectedFilePath && (model.inspection.filePaths ?? []).includes(state.selectedFilePath)) {
    return state.selectedFilePath;
  }

  return model.inspection.selectedFilePath;
}

function resolveDiffPathForOffset(
  ranges: Array<{ path: string; start: number; end: number }>,
  offset: number,
): string | null {
  return ranges.find((range) => offset >= range.start && offset < range.end)?.path ?? ranges.at(-1)?.path ?? null;
}

function updateIndexedValue<Key extends "focusedRegion" | "activeTab" | "selectedActionId">(
  state: ControlShellState,
  key: Key,
  values: readonly ControlShellState[Key][],
  direction: number,
): MainKeyResult {
  const index = values.indexOf(state[key]);
  const nextIndex = clamp(index + direction, 0, values.length - 1);
  const nextValue = values[nextIndex];

  if (!nextValue || nextValue === state[key]) {
    return result({ state });
  }

  return result({
    state: { ...state, [key]: nextValue, actionMessage: null },
    changed: true,
  });
}

function updateDynamicValue<Key extends "selectedTaskId" | "selectedLeftItemId" | "selectedFilePath" | "selectedDiffPath" | "selectedProjectTargetId">(
  state: ControlShellState,
  key: Key,
  values: string[],
  direction: number,
  refreshInspection = false,
): MainKeyResult {
  if (values.length === 0) {
    return result({ state });
  }

  const index = values.indexOf(state[key] ?? values[0] ?? "");
  const nextIndex = clamp(index === -1 ? 0 : index + direction, 0, values.length - 1);
  const nextValue = values[nextIndex] ?? null;

  if (nextValue === state[key]) {
    return result({ state });
  }

  return result({
    state: { ...state, [key]: nextValue, actionMessage: null },
    changed: true,
    refreshInspection,
  });
}

function updateValueInList<const Values extends readonly string[]>(
  value: Values[number],
  values: Values,
  direction: -1 | 1,
): Values[number] {
  const index = values.indexOf(value);
  return values[clamp(index + direction, 0, values.length - 1)] ?? value;
}

function result(input: {
  state: ControlShellState;
  changed?: boolean;
  exit?: boolean;
  pause?: boolean;
  attachTerminal?: boolean;
  detachTerminal?: boolean;
  beginTaskPrompt?: boolean;
  openWorkspaceBrowser?: boolean;
  createWorkspaceTask?: boolean;
  createPtyTab?: boolean;
  createPtyTabKind?: TaskPtyTabKind | null;
  createPtyTabRunner?: RunnerType | null;
  closePtyTab?: boolean;
  refreshPullRequestChecks?: boolean;
  closeTask?: boolean;
  removeWorkspace?: boolean;
  refreshInspection?: boolean;
}): MainKeyResult {
  return {
    state: input.state,
    changed: input.changed ?? false,
    exit: input.exit ?? false,
    pause: input.pause ?? false,
    attachTerminal: input.attachTerminal ?? false,
    detachTerminal: input.detachTerminal ?? false,
    beginTaskPrompt: input.beginTaskPrompt ?? false,
    openWorkspaceBrowser: input.openWorkspaceBrowser ?? false,
    createWorkspaceTask: input.createWorkspaceTask ?? false,
    createPtyTab: input.createPtyTab ?? false,
    createPtyTabKind: input.createPtyTabKind ?? null,
    createPtyTabRunner: input.createPtyTabRunner ?? null,
    closePtyTab: input.closePtyTab ?? false,
    refreshPullRequestChecks: input.refreshPullRequestChecks ?? false,
    closeTask: input.closeTask ?? false,
    removeWorkspace: input.removeWorkspace ?? false,
    refreshInspection: input.refreshInspection ?? false,
  };
}

function getValidValue<const Values extends readonly string[]>(
  value: string | null | undefined,
  values: Values,
  fallback: Values[number],
): Values[number] {
  return values.includes(value ?? "") ? (value as Values[number]) : fallback;
}

function getValidFocusRegion(value: string | null | undefined): FocusRegion {
  if (value === "tabs") {
    return "center";
  }

  return getValidValue(value, FOCUS_REGIONS, "tasks");
}

function getValidInspectionMode(value: string | null | undefined, fallback: InspectionMode): InspectionMode {
  if (value === "checks" || value === "actions" || value === "review") {
    return "review";
  }

  return getValidValue(value, INSPECTION_MODE_IDS, fallback);
}

function getValidOpenInspectionKind(value: string | null | undefined): OpenInspectionKind | null {
  if (value === "file" || value === "diff") {
    return value;
  }

  return null;
}

function getValidPtyTabKind(value: string | null | undefined): TaskPtyTabKind {
  return value === "terminal" ? "terminal" : "agent";
}

function getValidInputMode(value: string | null | undefined): InputMode {
  return value === "terminal" ? "terminal" : "control";
}

function getValidRunner(
  value: string | null | undefined,
  enabledRunnerIds: RunnerType[] = [...RUNNER_IDS],
  fallback: RunnerType = "codex",
): RunnerType {
  return value && isRunnerType(value) && enabledRunnerIds.includes(value) ? value : fallback;
}

export function getNextRunner(runner: RunnerType, enabledRunnerIds: readonly RunnerType[] = RUNNER_IDS): RunnerType {
  const runners = enabledRunnerIds.length > 0 ? enabledRunnerIds : RUNNER_IDS;
  const index = runners.indexOf(runner);
  return runners[(index + 1) % runners.length] ?? runners[0] ?? "codex";
}

function getPtyTabKindFromId(tabId: string): TaskPtyTabKind | null {
  const runnerSuffixes = RUNNER_IDS.join("|");
  if (new RegExp(`:(?:agent|${runnerSuffixes})(?:-\\d+)?$`).test(tabId)) {
    return "agent";
  }

  if (/:terminal(?:-\d+)?$/.test(tabId)) {
    return "terminal";
  }

  return null;
}

function getCreatePtyTabKind(state: ControlShellState, key: string): TaskPtyTabKind {
  if (key === "a" || key === "A") {
    return "agent";
  }

  if (key === "t" || key === "T") {
    return "terminal";
  }

  return getPtyTabKindFromId(state.activeTab) ?? state.preferredPtyTabKind;
}

function resolveTaskTabs(
  task: TaskRecord | null,
  activeTab: ControlShellState["activeTab"],
  currentTabId: string | null,
): Pick<ControlShellState, "activeTab" | "selectedPtyTabId"> {
  if (!task) {
    return {
      activeTab: activeTab === INSPECTION_TAB_ID ? activeTab : "agent",
      selectedPtyTabId: null,
    };
  }

  const currentTab = task.ptyTabs.find((tab) => tab.id === currentTabId) ?? null;
  const taskSelectedTab = task.selectedPtyTabId
    ? task.ptyTabs.find((tab) => tab.id === task.selectedPtyTabId) ?? null
    : null;
  const activeConcreteTab = task.ptyTabs.find((tab) => tab.id === activeTab) ?? null;

  if (activeConcreteTab) {
    return { activeTab: activeConcreteTab.id, selectedPtyTabId: activeConcreteTab.id };
  }

  if (isLegacyPtySurface(activeTab)) {
    const matchingLegacyTab = task.ptyTabs.find((tab) => tab.kind === activeTab) ?? null;
    const selected = matchingLegacyTab ?? taskSelectedTab ?? currentTab ?? task.ptyTabs[0] ?? null;
    return {
      activeTab: selected?.id ?? INSPECTION_TAB_ID,
      selectedPtyTabId: selected?.id ?? null,
    };
  }

  if (activeTab === INSPECTION_TAB_ID) {
    return {
      activeTab: INSPECTION_TAB_ID,
      selectedPtyTabId: currentTab?.id ?? taskSelectedTab?.id ?? task.ptyTabs[0]?.id ?? null,
    };
  }

  const fallbackTab = taskSelectedTab ?? currentTab ?? task.ptyTabs[0] ?? null;
  return {
    activeTab: fallbackTab?.id ?? INSPECTION_TAB_ID,
    selectedPtyTabId: fallbackTab?.id ?? null,
  };
}

function resolveFileTreeState(
  state: ControlShellState,
  model: RestoreShellModel,
  selectedTaskId: string | null,
): Pick<ControlShellState, "selectedFileTreePath" | "collapsedFileTreePaths"> {
  if (!model.inspection || model.inspection.taskId !== selectedTaskId) {
    return {
      selectedFileTreePath: state.selectedFileTreePath,
      collapsedFileTreePaths: state.collapsedFileTreePaths,
    };
  }

  const selectedFileTreePath = state.selectedFileTreePath ?? model.inspection.selectedFilePath;
  const collapsedFileTreePaths =
    state.selectedFileTreePath === null && state.collapsedFileTreePaths.length === 0
      ? getDefaultCollapsedFileTreePaths(model.inspection.fileRows ?? [], model.inspection.selectedFilePath)
      : state.collapsedFileTreePaths;

  return {
    selectedFileTreePath,
    collapsedFileTreePaths,
  };
}

function getDefaultCollapsedFileTreePaths(rows: Array<{ kind: string; path: string }>, selectedFilePath: string | null): string[] {
  const selectedAncestors = new Set<string>();
  if (selectedFilePath) {
    const parts = selectedFilePath.split("/");
    for (let index = 1; index < parts.length; index += 1) {
      selectedAncestors.add(parts.slice(0, index).join("/"));
    }
  }

  return rows
    .filter((row) => row.kind === "directory" && !row.path.includes("/") && !selectedAncestors.has(row.path))
    .map((row) => row.path)
    .sort((left, right) => left.localeCompare(right));
}

function buildCenterTabIdsFromState(state: ControlShellState): CenterTabId[] {
  return [
    state.selectedPtyTabId,
    state.openInspectionKind ? INSPECTION_TAB_ID : null,
  ].filter((entry): entry is string => typeof entry === "string");
}

function isConcretePtyTab(tabId: string, ptyTabIds: string[]): boolean {
  return ptyTabIds.includes(tabId);
}

function resolveLeftItemId(state: ControlShellState, model: RestoreShellModel): string | null {
  const leftItemIds = getLeftItemIds(model);

  if (state.selectedLeftItemId && leftItemIds.includes(state.selectedLeftItemId)) {
    return state.selectedLeftItemId;
  }

  if (state.selectedWorkspaceId && leftItemIds.includes(`workspace:${state.selectedWorkspaceId}`)) {
    return `workspace:${state.selectedWorkspaceId}`;
  }

  if (state.selectedTaskId && leftItemIds.includes(`task:${state.selectedTaskId}`)) {
    return `task:${state.selectedTaskId}`;
  }

  if (state.selectedRepoId && leftItemIds.includes(`repo:${state.selectedRepoId}`)) {
    return `repo:${state.selectedRepoId}`;
  }

  return leftItemIds[0] ?? null;
}

function getLeftItemIds(model: RestoreShellModel): string[] {
  const itemIds: string[] = [];

  if (model.workspaces?.length) {
    for (const workspace of model.workspaces) {
      itemIds.push(`workspace:${workspace.id}`);
      for (const task of model.tasks.filter((entry) => entry.workspaceId === workspace.id)) {
        itemIds.push(`task:${task.id}`);
      }
      if (workspace.kind === "project") {
        itemIds.push(`new-task-workspace:${workspace.id}`);
      }
      if (workspace.kind === "repo") {
        itemIds.push(`new-task:${workspace.primaryRepoId}`);
      }
    }
  } else {
    for (const repo of model.repos) {
      itemIds.push(`repo:${repo.id}`);
      for (const task of model.tasks.filter((entry) => entry.repoId === repo.id)) {
        itemIds.push(`task:${task.id}`);
      }
      itemIds.push(`new-task:${repo.id}`);
    }
  }

  itemIds.push("new-workspace");
  return itemIds;
}

function parseLeftItemId(value: string | null): { kind: "workspace" | "repo" | "task"; id: string } | null {
  if (!value) {
    return null;
  }

  if (value.startsWith("workspace:")) {
    return { kind: "workspace", id: value.slice("workspace:".length) };
  }

  if (value.startsWith("repo:")) {
    return { kind: "repo", id: value.slice("repo:".length) };
  }

  if (value.startsWith("task:")) {
    return { kind: "task", id: value.slice("task:".length) };
  }

  return null;
}

function optionalString(value: string | null | undefined): string | null {
  return typeof value === "string" ? value : null;
}

function buildSelectedTaskLeftItemId(taskId: string | null): LeftNavItemId | null {
  return taskId ? `task:${taskId}` : null;
}

export function isTaskLeftItemId(value: LeftNavItemId | null): boolean {
  return typeof value === "string" && value.startsWith("task:");
}

function isNewTaskLeftItemId(value: LeftNavItemId | null): boolean {
  return typeof value === "string" && value.startsWith("new-task:");
}

function isNewTaskWorkspaceLeftItemId(value: LeftNavItemId | null): boolean {
  return typeof value === "string" && value.startsWith("new-task-workspace:");
}

function isWorkspaceLeftItemId(value: LeftNavItemId | null): boolean {
  return typeof value === "string" && value.startsWith("workspace:");
}

function getNewTaskRepoId(value: LeftNavItemId | null): string | null {
  if (!isNewTaskLeftItemId(value)) return null;
  return (value as string).slice("new-task:".length);
}

function getNewTaskWorkspaceId(value: LeftNavItemId | null): string | null {
  if (!isNewTaskWorkspaceLeftItemId(value)) return null;
  return (value as string).slice("new-task-workspace:".length);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
