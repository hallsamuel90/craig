import { getDefaultUiState } from "../state/ui-state-store.js";
import { configService, RUNNER_IDS } from "../domain/config/index.js";
import type { CraigConfig, RunnerType } from "../domain/config/index.js";
import type { TaskPtyTabKind, TaskRecord } from "../domain/task/index.js";
import type { RepoRecord, WorkspaceRecord } from "../domain/workspace/index.js";
import type { CraigUiRuntime } from "../state/ui-runtime.js";
import type { TerminalScreenRow } from "./terminal-emulator.js";

export const FOCUS_REGIONS = ["tasks", "center", "inspector", "actions"] as const;
export const LEGACY_PTY_SURFACE_IDS = ["agent", "terminal"] as const;
export const FIXED_CENTER_TAB_IDS = [] as const;
export const INSPECTION_TAB_ID = "inspection";
export const CENTER_TAB_IDS = [...LEGACY_PTY_SURFACE_IDS, ...FIXED_CENTER_TAB_IDS] as const;
export const ACTION_IDS = ["commit", "push", "refresh-checks", "close-task"] as const;
export const REVIEW_ACTION_IDS = ["refresh-checks", "close-task"] as const;
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
export type FooterToastTone = "success" | "error";

export interface FooterToast {
  tone: FooterToastTone;
  message: string;
}

export interface WorkspaceBrowserEntry {
  name: string;
  path: string;
  kind: "directory" | "repo";
}

export interface WorkspaceBrowserState {
  cwd: string;
  entries: WorkspaceBrowserEntry[];
  selectedIndex: number;
  query: string | null;
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
  footerToast: FooterToast | null;
  taskPromptInput: string | null;
  taskPromptError: string | null;
  fileSearchQuery: string | null;
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
  openPrUrl: boolean;
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
  const enabledRunnerIds = configService.runners.getEnabled(config);
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
    selectedRunner: getValidRunner(runtime?.selectedRunner, enabledRunnerIds, configService.runners.getDefault(config)),
    centerTabRunner: null,
    actionMessage: null,
    footerToast: null,
    taskPromptInput: null,
    taskPromptError: null,
    fileSearchQuery: null,
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
  return value && configService.runners.isRunnerType(value) && enabledRunnerIds.includes(value) ? value : fallback;
}

export function getNextRunner(runner: RunnerType, enabledRunnerIds: readonly RunnerType[] = RUNNER_IDS): RunnerType {
  const runners = enabledRunnerIds.length > 0 ? enabledRunnerIds : RUNNER_IDS;
  const index = runners.indexOf(runner);
  return runners[(index + 1) % runners.length] ?? runners[0] ?? "codex";
}

export function getPtyTabKindFromId(tabId: string): TaskPtyTabKind | null {
  const runnerSuffixes = RUNNER_IDS.join("|");
  if (new RegExp(`:(?:agent|${runnerSuffixes})(?:-\\d+)?$`).test(tabId)) {
    return "agent";
  }

  if (/:terminal(?:-\d+)?$/.test(tabId)) {
    return "terminal";
  }

  return null;
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

export function getLeftItemIds(model: { workspaces?: WorkspaceRecord[]; repos: RepoRecord[]; tasks: TaskRecord[] }): string[] {
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

export function parseLeftItemId(value: string | null): { kind: "workspace" | "repo" | "task"; id: string } | null {
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

export function isNewTaskLeftItemId(value: LeftNavItemId | null): boolean {
  return typeof value === "string" && value.startsWith("new-task:");
}

export function isNewTaskWorkspaceLeftItemId(value: LeftNavItemId | null): boolean {
  return typeof value === "string" && value.startsWith("new-task-workspace:");
}

export function isWorkspaceLeftItemId(value: LeftNavItemId | null): boolean {
  return typeof value === "string" && value.startsWith("workspace:");
}

export function getNewTaskRepoId(value: LeftNavItemId | null): string | null {
  if (!isNewTaskLeftItemId(value)) return null;
  return (value as string).slice("new-task:".length);
}

export function getNewTaskWorkspaceId(value: LeftNavItemId | null): string | null {
  if (!isNewTaskWorkspaceLeftItemId(value)) return null;
  return (value as string).slice("new-task-workspace:".length);
}

