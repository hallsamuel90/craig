import { getDefaultUiState } from "../state/ui-state-store.js";
import type { CraigUiRuntime } from "../types/workspace.js";
import type { TerminalScreenRow } from "./terminal-emulator.js";

export const FOCUS_REGIONS = ["tasks", "center", "actions"] as const;
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

export type InputMode = "control" | "terminal";
export type FocusRegion = (typeof FOCUS_REGIONS)[number];
export type MockTaskId = (typeof MOCK_TASK_IDS)[number];
export type CenterTabId = (typeof CENTER_TAB_IDS)[number];
export type MockActionId = (typeof MOCK_ACTION_IDS)[number];
export type TerminalStatus = "idle" | "running" | "exited" | "failed";

export interface TerminalViewState {
  status: TerminalStatus;
  rows: TerminalScreenRow[];
  error: string | null;
}

export interface ControlShellState {
  inputMode: InputMode;
  focusedRegion: FocusRegion;
  selectedTaskId: MockTaskId;
  activeTab: CenterTabId;
  selectedActionId: MockActionId;
  actionMessage: string | null;
  terminal: TerminalViewState;
}

export interface MainKeyResult {
  state: ControlShellState;
  changed: boolean;
  exit: boolean;
  pause: boolean;
  attachTerminal: boolean;
  detachTerminal: boolean;
}

export function createInitialShellState(runtime: CraigUiRuntime | null): ControlShellState {
  return {
    inputMode: "control",
    focusedRegion: getValidFocusRegion(runtime?.focusedRegion),
    selectedTaskId: getValidValue(runtime?.selectedTaskId, MOCK_TASK_IDS, "task_20260430_02"),
    activeTab: getValidValue(runtime?.activeTab, CENTER_TAB_IDS, "agent"),
    selectedActionId: getValidValue(runtime?.selectedActionId, MOCK_ACTION_IDS, "commit"),
    actionMessage: null,
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
    selectedTaskId: state.selectedTaskId,
    inputMode: "control",
    focusedRegion: state.focusedRegion,
    activeTab: state.activeTab,
    selectedActionId: state.selectedActionId,
  };
}

export function reduceMainKey(state: ControlShellState, key: string): MainKeyResult {
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
    if (state.focusedRegion === "center" && state.activeTab === "terminal") {
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
        actionMessage: `Mock action: ${state.selectedActionId} (phase 1.2).`,
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
    activeTab: "terminal",
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

  if (state.focusedRegion === "center") {
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
}): MainKeyResult {
  return {
    state: input.state,
    changed: input.changed ?? false,
    exit: input.exit ?? false,
    pause: input.pause ?? false,
    attachTerminal: input.attachTerminal ?? false,
    detachTerminal: input.detachTerminal ?? false,
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

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
