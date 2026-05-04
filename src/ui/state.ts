import { getDefaultUiState } from "../state/ui-state-store.js";
import type { CraigUiRuntime } from "../types/workspace.js";
import type { TerminalScreenRow } from "./terminal-emulator.js";

export const FOCUS_REGIONS = ["tasks", "center", "actions"] as const;
export const CENTER_TAB_IDS = ["agent", "files", "diff", "terminal", "logs"] as const;
export const ACTION_IDS = ["commit", "push", "create-pr", "merge", "close-task"] as const;

export type InputMode = "control" | "terminal";
export type FocusRegion = (typeof FOCUS_REGIONS)[number];
export type CenterTabId = (typeof CENTER_TAB_IDS)[number];
export type ActionId = (typeof ACTION_IDS)[number];
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
  selectedActionId: ActionId;
  actionMessage: string | null;
  taskPromptInput: string | null;
  taskPromptError: string | null;
  workspaceBrowser: WorkspaceBrowserState | null;
  terminal: TerminalViewState;
}

export interface ReduceMainKeyOptions {
  leftItemIds: LeftNavItemId[];
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
}

export function createInitialShellState(runtime: CraigUiRuntime | null): ControlShellState {
  return {
    inputMode: "control",
    focusedRegion: getValidFocusRegion(runtime?.focusedRegion),
    selectedRepoId: optionalString(runtime?.selectedRepoId),
    selectedTaskId: optionalString(runtime?.selectedTaskId),
    selectedPtyTabId: optionalString(runtime?.selectedPtyTabId),
    selectedLeftItemId: buildSelectedTaskLeftItemId(optionalString(runtime?.selectedTaskId)),
    activeTab: getValidValue(runtime?.activeTab, CENTER_TAB_IDS, "agent"),
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
    selectedActionId: state.selectedActionId,
  };
}

export function reduceMainKey(
  state: ControlShellState,
  key: string,
  options: ReduceMainKeyOptions = { leftItemIds: [] },
): MainKeyResult {
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
    return moveSelection(state, -1, options.leftItemIds);
  }

  if (key === "DOWN" || key === "j") {
    return moveSelection(state, 1, options.leftItemIds);
  }

  if (key === "LEFT" || key === "h") {
    if (state.focusedRegion === "center") {
      return moveTab(state, -1);
    }

    return updateFocus(state, -1);
  }

  if (key === "RIGHT" || key === "l") {
    if (state.focusedRegion === "center") {
      return moveTab(state, 1);
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
          activeTab: "agent",
          actionMessage: null,
        },
        changed: true,
        attachTerminal: true,
      });
    }

    if (state.focusedRegion === "center" && isPtyTab(state.activeTab) && state.selectedTaskId) {
      return result({
        state: { ...state, inputMode: "terminal", actionMessage: null },
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
  return tabId === "agent" || tabId === "terminal";
}

function updateFocus(state: ControlShellState, direction: -1 | 1): MainKeyResult {
  return updateIndexedValue(state, "focusedRegion", FOCUS_REGIONS, direction);
}

function moveTab(state: ControlShellState, direction: -1 | 1): MainKeyResult {
  return updateIndexedValue(state, "activeTab", CENTER_TAB_IDS, direction);
}

function moveSelection(state: ControlShellState, direction: -1 | 1, taskIds: string[]): MainKeyResult {
  if (state.focusedRegion === "tasks") {
    return updateDynamicValue(state, "selectedLeftItemId", taskIds, direction);
  }

  if (state.focusedRegion === "center") {
    return moveTab(state, direction);
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
