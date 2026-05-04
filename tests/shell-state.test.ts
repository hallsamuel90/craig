import { describe, expect, test } from "vitest";

import type { CraigUiRuntime } from "../src/types/workspace.js";
import { createInitialShellState, reduceMainKey, toPersistedUiState } from "../src/ui/state.js";

describe("terminal shell control state", () => {
  test("initializes from valid runtime state", () => {
    const state = createInitialShellState({
      version: 1,
      selectedRepoId: null,
      selectedWorkspaceId: null,
      selectedTaskId: "task_20260430_04",
      inputMode: "control",
      focusedRegion: "actions",
      activeTab: "logs",
      selectedActionId: "merge",
      updatedAt: "2026-05-03T00:00:00.000Z",
    });

    expect(state).toMatchObject({
      inputMode: "control",
      focusedRegion: "actions",
      selectedTaskId: "task_20260430_04",
      activeTab: "logs",
      selectedActionId: "merge",
      actionMessage: null,
    });
  });

  test("falls back when persisted mock values are stale", () => {
    const state = createInitialShellState({
      version: 1,
      selectedRepoId: null,
      selectedWorkspaceId: null,
      selectedTaskId: "task_deleted",
      inputMode: "control",
      focusedRegion: "missing",
      activeTab: "review",
      selectedActionId: "deploy",
      updatedAt: "2026-05-03T00:00:00.000Z",
    } as unknown as CraigUiRuntime);

    expect(state.focusedRegion).toBe("tasks");
    expect(state.selectedTaskId).toBe("task_20260430_02");
    expect(state.activeTab).toBe("agent");
    expect(state.selectedActionId).toBe("commit");
  });

  test("maps the old tabs focus region to the center pane", () => {
    const state = createInitialShellState({
      version: 1,
      selectedRepoId: null,
      selectedWorkspaceId: null,
      selectedTaskId: "task_20260430_02",
      inputMode: "control",
      focusedRegion: "tabs",
      activeTab: "terminal",
      selectedActionId: "commit",
      updatedAt: "2026-05-03T00:00:00.000Z",
    });

    expect(state.focusedRegion).toBe("center");
  });

  test("cycles focus with tab-style keys and clamps at region edges", () => {
    const initial = createInitialShellState(null);
    const center = reduceMainKey(initial, "TAB").state;
    const actions = reduceMainKey(center, "]").state;
    const stillActions = reduceMainKey(actions, "]").state;
    const backToCenter = reduceMainKey(stillActions, "[").state;

    expect(center.focusedRegion).toBe("center");
    expect(actions.focusedRegion).toBe("actions");
    expect(stillActions.focusedRegion).toBe("actions");
    expect(backToCenter.focusedRegion).toBe("center");
  });

  test("moves task, tab, and action selections through Craig control mode", () => {
    const tasks = createInitialShellState(null);
    const nextTask = reduceMainKey(tasks, "DOWN").state;
    const center = reduceMainKey(nextTask, "TAB").state;
    const nextTab = reduceMainKey(center, "RIGHT").state;
    const actions = reduceMainKey(reduceMainKey(nextTab, "TAB").state, "DOWN").state;

    expect(nextTask.selectedTaskId).toBe("task_20260430_03");
    expect(nextTab.activeTab).toBe("files");
    expect(actions.selectedActionId).toBe("push");
  });

  test("enter on actions emits a non-destructive mock message", () => {
    const focusedAction = reduceMainKey(reduceMainKey(createInitialShellState(null), "TAB").state, "TAB").state;
    const result = reduceMainKey(focusedAction, "ENTER");

    expect(result.exit).toBe(false);
    expect(result.pause).toBe(false);
    expect(result.changed).toBe(true);
    expect(result.state.actionMessage).toBe("Mock action: commit (phase 1.2).");
  });

  test("enter on the focused terminal tab attaches terminal mode", () => {
    const center = reduceMainKey(createInitialShellState(null), "TAB").state;
    const terminal = ["RIGHT", "RIGHT", "RIGHT"].reduce((state, key) => reduceMainKey(state, key).state, center);
    const result = reduceMainKey(terminal, "ENTER");

    expect(result.attachTerminal).toBe(true);
    expect(result.state.inputMode).toBe("terminal");
    expect(result.state.activeTab).toBe("terminal");
    expect(result.state.selectedTaskId).toBe("task_20260430_02");
  });

  test("raw carriage return also attaches from the focused terminal tab", () => {
    const center = reduceMainKey(createInitialShellState(null), "TAB").state;
    const terminal = ["RIGHT", "RIGHT", "RIGHT"].reduce((state, key) => reduceMainKey(state, key).state, center);
    const result = reduceMainKey(terminal, "\r");

    expect(result.attachTerminal).toBe(true);
    expect(result.state.inputMode).toBe("terminal");
  });

  test("ctrl-m style enter aliases attach from the focused terminal tab", () => {
    const center = reduceMainKey(createInitialShellState(null), "TAB").state;
    const terminal = ["RIGHT", "RIGHT", "RIGHT"].reduce((state, key) => reduceMainKey(state, key).state, center);

    expect(reduceMainKey(terminal, "CTRL_M").attachTerminal).toBe(true);
    expect(reduceMainKey(terminal, "RETURN").attachTerminal).toBe(true);
  });

  test("enter does not attach when the terminal tab is active outside the center region", () => {
    const state = {
      ...createInitialShellState(null),
      focusedRegion: "tasks" as const,
      activeTab: "terminal" as const,
    };
    const result = reduceMainKey(state, "ENTER");

    expect(result.attachTerminal).toBe(false);
    expect(result.state.inputMode).toBe("control");
  });

  test("enter still runs mock actions when actions are focused on the terminal tab", () => {
    const state = {
      ...createInitialShellState(null),
      focusedRegion: "actions" as const,
      activeTab: "terminal" as const,
    };
    const result = reduceMainKey(state, "ENTER");

    expect(result.attachTerminal).toBe(false);
    expect(result.state.inputMode).toBe("control");
    expect(result.state.actionMessage).toBe("Mock action: commit (phase 1.2).");
  });

  test("ctrl+] detaches terminal mode without losing selected tab or task", () => {
    const attached = {
      ...createInitialShellState(null),
      inputMode: "terminal" as const,
      activeTab: "terminal" as const,
      selectedTaskId: "task_20260430_04" as const,
    };
    const result = reduceMainKey(attached, "\u001D");

    expect(result.detachTerminal).toBe(true);
    expect(result.state.inputMode).toBe("control");
    expect(result.state.activeTab).toBe("terminal");
    expect(result.state.selectedTaskId).toBe("task_20260430_04");
  });

  test("non-detach terminal keys are left for the PTY owner", () => {
    const attached = {
      ...createInitialShellState(null),
      inputMode: "terminal" as const,
      activeTab: "terminal" as const,
    };
    const result = reduceMainKey(attached, "q");

    expect(result.exit).toBe(false);
    expect(result.changed).toBe(false);
    expect(result.detachTerminal).toBe(false);
    expect(result.state.inputMode).toBe("terminal");
  });

  test("escape always requests pause and clears transient action feedback", () => {
    const focusedAction = reduceMainKey(reduceMainKey(createInitialShellState(null), "TAB").state, "TAB").state;
    const withMessage = reduceMainKey(focusedAction, "ENTER").state;
    const result = reduceMainKey(withMessage, "ESCAPE");

    expect(result.pause).toBe(true);
    expect(result.state.actionMessage).toBeNull();
  });

  test("persists only restorable shell selection fields", () => {
    const state = {
      ...createInitialShellState(null),
      focusedRegion: "actions" as const,
      activeTab: "logs" as const,
      selectedActionId: "merge" as const,
      actionMessage: "transient",
    };

    const persisted = toPersistedUiState(null, state);

    expect(persisted).toMatchObject({
      inputMode: "control",
      focusedRegion: "actions",
      selectedTaskId: "task_20260430_02",
      activeTab: "logs",
      selectedActionId: "merge",
    });
    expect(persisted).not.toHaveProperty("actionMessage");
  });
});
