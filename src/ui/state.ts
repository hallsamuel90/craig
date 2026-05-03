import { getDefaultUiState } from "../state/ui-state-store.js";
import type { CraigUiRuntime } from "../types/workspace.js";

export const FOCUS_REGIONS = ["tasks", "tabs", "actions"] as const;
export const MOCK_TASK_IDS = [
  "task_20260430_01",
  "task_20260430_02",
  "task_20260430_03",
  "task_20260430_04",
  "task_20260430_05",
  "task_20260430_06",
] as const;
export const CENTER_TAB_IDS = ["agent", "files", "diff", "terminal", "logs"] as const;
export const MOCK_ACTION_IDS = ["commit", "push", "create-pr", "merge", "close-task"] as const;

export type FocusRegion = (typeof FOCUS_REGIONS)[number];
export type MockTaskId = (typeof MOCK_TASK_IDS)[number];
export type CenterTabId = (typeof CENTER_TAB_IDS)[number];
export type MockActionId = (typeof MOCK_ACTION_IDS)[number];

export interface ControlShellState {
  inputMode: "control";
  focusedRegion: FocusRegion;
  selectedTaskId: MockTaskId;
  activeTab: CenterTabId;
  selectedActionId: MockActionId;
  actionMessage: string | null;
}

export interface MainKeyResult {
  state: ControlShellState;
  changed: boolean;
  exit: boolean;
  pause: boolean;
}

export function createInitialShellState(runtime: CraigUiRuntime | null): ControlShellState {
  return {
    inputMode: "control",
    focusedRegion: getValidValue(runtime?.focusedRegion, FOCUS_REGIONS, "tasks"),
    selectedTaskId: getValidValue(runtime?.selectedTaskId, MOCK_TASK_IDS, "task_20260430_02"),
    activeTab: getValidValue(runtime?.activeTab, CENTER_TAB_IDS, "agent"),
    selectedActionId: getValidValue(runtime?.selectedActionId, MOCK_ACTION_IDS, "commit"),
    actionMessage: null,
  };
}

export function toPersistedUiState(runtime: CraigUiRuntime | null, state: ControlShellState): CraigUiRuntime {
  return {
    ...(runtime ?? getDefaultUiState()),
    selectedTaskId: state.selectedTaskId,
    inputMode: state.inputMode,
    focusedRegion: state.focusedRegion,
    activeTab: state.activeTab,
    selectedActionId: state.selectedActionId,
  };
}

export function reduceMainKey(state: ControlShellState, key: string): MainKeyResult {
  if (key === "q" || key === "Q") {
    return { state, changed: false, exit: true, pause: false };
  }

  if (key === "ESCAPE") {
    return { state: { ...state, actionMessage: null }, changed: state.actionMessage !== null, exit: false, pause: true };
  }

  if (key === "TAB" || key === "]") {
    return updateFocus(state, 1);
  }

  if (key === "SHIFT_TAB" || key === "[") {
    return updateFocus(state, -1);
  }

  if (key === "UP" || key === "k") {
    return moveSelection(state, -1);
  }

  if (key === "DOWN" || key === "j") {
    return moveSelection(state, 1);
  }

  if (key === "LEFT" || key === "h") {
    if (state.focusedRegion === "tabs") {
      return moveTab(state, -1);
    }

    return updateFocus(state, -1);
  }

  if (key === "RIGHT" || key === "l") {
    if (state.focusedRegion === "tabs") {
      return moveTab(state, 1);
    }

    return updateFocus(state, 1);
  }

  if (key === "ENTER" || key === "KP_ENTER") {
    if (state.focusedRegion !== "actions") {
      return { state, changed: false, exit: false, pause: false };
    }

    return {
      state: {
        ...state,
        actionMessage: `Mock action: ${state.selectedActionId} (phase 1.2).`,
      },
      changed: true,
      exit: false,
      pause: false,
    };
  }

  return { state, changed: false, exit: false, pause: false };
}

function updateFocus(state: ControlShellState, direction: -1 | 1): MainKeyResult {
  return updateIndexedValue(state, "focusedRegion", FOCUS_REGIONS, direction);
}

function moveTab(state: ControlShellState, direction: -1 | 1): MainKeyResult {
  return updateIndexedValue(state, "activeTab", CENTER_TAB_IDS, direction);
}

function moveSelection(state: ControlShellState, direction: -1 | 1): MainKeyResult {
  if (state.focusedRegion === "tasks") {
    return updateIndexedValue(state, "selectedTaskId", MOCK_TASK_IDS, direction);
  }

  if (state.focusedRegion === "tabs") {
    return moveTab(state, direction);
  }

  return updateIndexedValue(state, "selectedActionId", MOCK_ACTION_IDS, direction);
}

function updateIndexedValue<Key extends "focusedRegion" | "selectedTaskId" | "activeTab" | "selectedActionId">(
  state: ControlShellState,
  key: Key,
  values: readonly ControlShellState[Key][],
  direction: -1 | 1,
): MainKeyResult {
  const index = values.indexOf(state[key]);
  const nextIndex = clamp(index + direction, 0, values.length - 1);
  const nextValue = values[nextIndex];

  if (!nextValue || nextValue === state[key]) {
    return { state, changed: false, exit: false, pause: false };
  }

  return {
    state: { ...state, [key]: nextValue, actionMessage: null },
    changed: true,
    exit: false,
    pause: false,
  };
}

function getValidValue<const Values extends readonly string[]>(
  value: string | null | undefined,
  values: Values,
  fallback: Values[number],
): Values[number] {
  return values.includes(value ?? "") ? (value as Values[number]) : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
