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

  test("cycles focus with tab-style keys and clamps at region edges", () => {
    const initial = createInitialShellState(null);
    const tabs = reduceMainKey(initial, "TAB").state;
    const actions = reduceMainKey(tabs, "]").state;
    const stillActions = reduceMainKey(actions, "]").state;
    const backToTabs = reduceMainKey(stillActions, "[").state;

    expect(tabs.focusedRegion).toBe("tabs");
    expect(actions.focusedRegion).toBe("actions");
    expect(stillActions.focusedRegion).toBe("actions");
    expect(backToTabs.focusedRegion).toBe("tabs");
  });

  test("moves task, tab, and action selections through Craig control mode", () => {
    const tasks = createInitialShellState(null);
    const nextTask = reduceMainKey(tasks, "DOWN").state;
    const tabs = reduceMainKey(nextTask, "TAB").state;
    const nextTab = reduceMainKey(tabs, "RIGHT").state;
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
