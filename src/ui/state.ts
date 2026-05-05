import { getDefaultUiState } from "../state/ui-state-store.js";
import type { TaskRecord } from "../types/task.js";
import type { RepoRecord } from "../types/workspace.js";
import type { CraigUiRuntime } from "../types/workspace.js";
import type { TerminalScreenRow } from "./terminal-emulator.js";

export const FOCUS_REGIONS = ["tasks", "center", "actions"] as const;
export const LEGACY_PTY_SURFACE_IDS = ["agent", "terminal"] as const;
export const FIXED_CENTER_TAB_IDS = ["files", "diff", "logs"] as const;
export const CENTER_TAB_IDS = [...LEGACY_PTY_SURFACE_IDS, ...FIXED_CENTER_TAB_IDS] as const;
export const ACTION_IDS = ["commit", "push", "create-pr", "merge", "close-task"] as const;
export const INSPECTOR_SECTION_IDS = ["task", "checks", "pr", "setup-run", "actions", "next-action"] as const;

export type InputMode = "control" | "terminal";
export type FocusRegion = (typeof FOCUS_REGIONS)[number];
export type CenterTabId = string;
export type FixedCenterTabId = (typeof FIXED_CENTER_TAB_IDS)[number];
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
}

export interface ControlShellState {
  inputMode: InputMode;
  focusedRegion: FocusRegion;
  selectedRepoId: string | null;
  selectedTaskId: string | null;
  selectedPtyTabId: string | null;
  selectedLeftItemId: LeftNavItemId | null;
  activeTab: CenterTabId;
  inspectorSection: InspectorSectionId;
  selectedActionId: ActionId;
  actionMessage: string | null;
  taskPromptInput: string | null;
  taskPromptError: string | null;
  workspaceBrowser: WorkspaceBrowserState | null;
  terminal: TerminalViewState;
}

export interface ReduceMainKeyOptions {
  leftItemIds: LeftNavItemId[];
  centerTabIds?: CenterTabId[];
  ptyTabIds?: string[];
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
  createPtyTab: boolean;
  closePtyTab: boolean;
}

export interface RestoreShellModel {
  repos: RepoRecord[];
  tasks: TaskRecord[];
}

export interface RestoreShellStateOptions {
  resetInputMode?: boolean;
}

export function createInitialShellState(runtime: CraigUiRuntime | null): ControlShellState {
  return {
    inputMode: "control",
    focusedRegion: getValidFocusRegion(runtime?.focusedRegion),
    selectedRepoId: optionalString(runtime?.selectedRepoId),
    selectedTaskId: optionalString(runtime?.selectedTaskId),
    selectedPtyTabId: optionalString(runtime?.selectedPtyTabId),
    selectedLeftItemId: buildSelectedTaskLeftItemId(optionalString(runtime?.selectedTaskId)),
    activeTab: optionalString(runtime?.activeTab) ?? "agent",
    inspectorSection: getValidValue(runtime?.inspectorSection, INSPECTOR_SECTION_IDS, "task"),
    selectedActionId: getValidValue(runtime?.selectedActionId, ACTION_IDS, "commit"),
    actionMessage: null,
    taskPromptInput: null,
    taskPromptError: null,
    workspaceBrowser: null,
    terminal: createDefaultTerminalViewState(),
  };
}

export function createDefaultTerminalViewState(): TerminalViewState {
  return {
    status: "idle",
    rows: [],
    error: null,
  };
}

export function toPersistedUiState(runtime: CraigUiRuntime | null, state: ControlShellState): CraigUiRuntime {
  return {
    ...(runtime ?? getDefaultUiState()),
    selectedRepoId: state.selectedRepoId,
    selectedTaskId: state.selectedTaskId,
    selectedPtyTabId: state.selectedPtyTabId,
    inputMode: "control",
    focusedRegion: state.focusedRegion,
    activeTab: state.activeTab,
    inspectorSection: state.inspectorSection,
    selectedActionId: state.selectedActionId,
  };
}

export function restoreShellState(
  state: ControlShellState,
  model: RestoreShellModel,
  options: RestoreShellStateOptions = {},
): ControlShellState {
  const selectedLeftItemId = resolveLeftItemId(state, model);
  const leftSelection = parseLeftItemId(selectedLeftItemId);
  const selectedRepo =
    (leftSelection?.kind === "repo"
      ? model.repos.find((repo) => repo.id === leftSelection.id) ?? null
      : leftSelection?.kind === "task"
        ? model.repos.find((repo) => repo.id === model.tasks.find((task) => task.id === leftSelection.id)?.repoId) ?? null
        : null) ??
    model.repos.find((repo) => repo.id === state.selectedRepoId) ??
    model.repos[0] ??
    null;
  const repoId = selectedRepo?.id ?? null;
  const repoTasks = repoId ? model.tasks.filter((task) => task.repoId === repoId) : [];
  const selectedTask =
    (leftSelection?.kind === "task" ? repoTasks.find((task) => task.id === leftSelection.id) ?? null : null) ??
    repoTasks.find((task) => task.id === state.selectedTaskId) ??
    repoTasks[0] ??
    null;

  return {
    ...state,
    inputMode: options.resetInputMode ? "control" : state.inputMode,
    selectedLeftItemId,
    selectedRepoId: repoId,
    selectedTaskId: selectedTask?.id ?? null,
    ...resolveTaskTabs(selectedTask, state.activeTab, state.selectedPtyTabId),
    inspectorSection: getValidValue(state.inspectorSection, INSPECTOR_SECTION_IDS, "task"),
  };
}

export function reduceMainKey(state: ControlShellState, key: string, options: ReduceMainKeyOptions = { leftItemIds: [] }): MainKeyResult {
  if (state.inputMode === "terminal") {
    if (isTerminalDetachKey(key)) {
      return result({
        state: { ...state, inputMode: "control", actionMessage: null },
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

  if (key === "TAB" || key === "]") {
    return updateFocus(state, 1);
  }

  if (key === "SHIFT_TAB" || key === "[") {
    return updateFocus(state, -1);
  }

  if (key === "UP" || key === "k") {
    return moveSelection(state, -1, options.leftItemIds, options.centerTabIds);
  }

  if (key === "DOWN" || key === "j") {
    return moveSelection(state, 1, options.leftItemIds, options.centerTabIds);
  }

  if (key === "+" && state.focusedRegion === "center" && state.selectedTaskId) {
    return result({ state: { ...state, actionMessage: null }, changed: true, createPtyTab: true });
  }

  if (key === "x" && state.focusedRegion === "center" && isConcretePtyTab(state.activeTab, options.ptyTabIds ?? [])) {
    return result({ state: { ...state, actionMessage: null }, changed: true, closePtyTab: true });
  }

  if (key === "LEFT" || key === "h") {
    if (state.focusedRegion === "center") {
      return moveTab(state, -1, options.centerTabIds);
    }

    return updateFocus(state, -1);
  }

  if (key === "RIGHT" || key === "l") {
    if (state.focusedRegion === "center") {
      return moveTab(state, 1, options.centerTabIds);
    }

    return updateFocus(state, 1);
  }

  if (isEnterKey(key)) {
    if (state.focusedRegion === "tasks" && state.selectedLeftItemId === "new-task") {
      return result({
        state: {
          ...state,
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
      return result({
        state: {
          ...state,
          inputMode: "terminal",
          activeTab: state.selectedPtyTabId ?? state.activeTab,
          actionMessage: null,
        },
        changed: true,
        attachTerminal: true,
      });
    }

    if (state.focusedRegion === "center" && isConcretePtyTab(state.activeTab, options.ptyTabIds ?? []) && state.selectedTaskId) {
      return result({
        state: { ...state, inputMode: "terminal", selectedPtyTabId: state.activeTab, actionMessage: null },
        changed: true,
        attachTerminal: true,
      });
    }

    if (state.focusedRegion !== "actions") {
      return result({ state });
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
  return !isFixedCenterTab(tabId);
}

export function isFixedCenterTab(tabId: string): tabId is FixedCenterTabId {
  return (FIXED_CENTER_TAB_IDS as readonly string[]).includes(tabId);
}

export function isLegacyPtySurface(tabId: string): tabId is (typeof LEGACY_PTY_SURFACE_IDS)[number] {
  return (LEGACY_PTY_SURFACE_IDS as readonly string[]).includes(tabId);
}

export function buildCenterTabIds(task: TaskRecord | null): CenterTabId[] {
  return [...(task?.ptyTabs.map((tab) => tab.id) ?? []), ...FIXED_CENTER_TAB_IDS];
}

function updateFocus(state: ControlShellState, direction: -1 | 1): MainKeyResult {
  const next = updateIndexedValue(state, "focusedRegion", FOCUS_REGIONS, direction);
  if (next.state.focusedRegion !== "actions" || next.state.inspectorSection === "actions") {
    return next;
  }

  return {
    ...next,
    state: {
      ...next.state,
      inspectorSection: "actions",
    },
  };
}

function moveTab(state: ControlShellState, direction: -1 | 1, centerTabIds: CenterTabId[] | undefined): MainKeyResult {
  const next = updateIndexedValue(
    state,
    "activeTab",
    centerTabIds && centerTabIds.length > 0 ? centerTabIds : buildCenterTabIdsFromState(state),
    direction,
  );
  if (!next.changed || isFixedCenterTab(next.state.activeTab)) {
    return next;
  }

  return {
    ...next,
    state: {
      ...next.state,
      selectedPtyTabId: next.state.activeTab,
    },
  };
}

function moveSelection(
  state: ControlShellState,
  direction: -1 | 1,
  taskIds: string[],
  centerTabIds: CenterTabId[] | undefined,
): MainKeyResult {
  if (state.focusedRegion === "tasks") {
    return updateDynamicValue(state, "selectedLeftItemId", taskIds, direction);
  }

  if (state.focusedRegion === "center") {
    return moveTab(state, direction, centerTabIds);
  }

  return updateIndexedValue(state, "selectedActionId", ACTION_IDS, direction);
}

function updateIndexedValue<Key extends "focusedRegion" | "activeTab" | "selectedActionId">(
  state: ControlShellState,
  key: Key,
  values: readonly ControlShellState[Key][],
  direction: -1 | 1,
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

function updateDynamicValue<Key extends "selectedTaskId" | "selectedLeftItemId">(
  state: ControlShellState,
  key: Key,
  values: string[],
  direction: -1 | 1,
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
  });
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
  createPtyTab?: boolean;
  closePtyTab?: boolean;
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
    createPtyTab: input.createPtyTab ?? false,
    closePtyTab: input.closePtyTab ?? false,
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

function resolveTaskTabs(
  task: TaskRecord | null,
  activeTab: ControlShellState["activeTab"],
  currentTabId: string | null,
): Pick<ControlShellState, "activeTab" | "selectedPtyTabId"> {
  if (!task) {
    return {
      activeTab: isFixedCenterTab(activeTab) ? activeTab : "files",
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
      activeTab: selected?.id ?? "files",
      selectedPtyTabId: selected?.id ?? null,
    };
  }

  if (isFixedCenterTab(activeTab)) {
    return {
      activeTab,
      selectedPtyTabId: currentTab?.id ?? taskSelectedTab?.id ?? task.ptyTabs[0]?.id ?? null,
    };
  }

  const fallbackTab = taskSelectedTab ?? currentTab ?? task.ptyTabs[0] ?? null;
  return {
    activeTab: fallbackTab?.id ?? "files",
    selectedPtyTabId: fallbackTab?.id ?? null,
  };
}

function buildCenterTabIdsFromState(state: ControlShellState): CenterTabId[] {
  return [state.selectedPtyTabId, ...FIXED_CENTER_TAB_IDS].filter((entry): entry is string => typeof entry === "string");
}

function isConcretePtyTab(tabId: string, ptyTabIds: string[]): boolean {
  return ptyTabIds.includes(tabId);
}

function resolveLeftItemId(state: ControlShellState, model: RestoreShellModel): string | null {
  const leftItemIds = getLeftItemIds(model);

  if (state.selectedLeftItemId && leftItemIds.includes(state.selectedLeftItemId)) {
    return state.selectedLeftItemId;
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

  for (const repo of model.repos) {
    itemIds.push(`repo:${repo.id}`);
    for (const task of model.tasks.filter((entry) => entry.repoId === repo.id)) {
      itemIds.push(`task:${task.id}`);
    }
  }

  itemIds.push("new-task");
  itemIds.push("new-workspace");
  return itemIds;
}

function parseLeftItemId(value: string | null): { kind: "repo" | "task"; id: string } | null {
  if (!value) {
    return null;
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

function isTaskLeftItemId(value: LeftNavItemId | null): boolean {
  return typeof value === "string" && value.startsWith("task:");
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
