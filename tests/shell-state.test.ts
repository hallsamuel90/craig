import { describe, expect, test } from "vitest";

import type { CraigUiRuntime } from "../src/types/workspace.js";
import { createInitialShellState, reduceMainKey, toPersistedUiState } from "../src/ui/state.js";

const LEFT_ITEM_IDS = [
  "repo:repo_bug_fixes",
  "task:task_20260430_02",
  "task:task_20260430_03",
  "repo:repo_testing",
  "task:task_20260430_04",
  "new-task",
  "new-workspace",
];

describe("terminal shell control state", () => {
  test("initializes from valid runtime state", () => {
    const state = createInitialShellState({
      version: 1,
      selectedRepoId: "repo_bug_fixes",
      selectedWorkspaceId: null,
      selectedTaskId: "task_20260430_04",
      selectedPtyTabId: "task_20260430_04:agent",
      inputMode: "control",
      focusedRegion: "actions",
      activeTab: "logs",
      selectedActionId: "merge",
      updatedAt: "2026-05-03T00:00:00.000Z",
    });

    expect(state).toMatchObject({
      inputMode: "control",
      focusedRegion: "actions",
      selectedRepoId: "repo_bug_fixes",
      selectedTaskId: "task_20260430_04",
      selectedPtyTabId: "task_20260430_04:agent",
      selectedLeftItemId: "task:task_20260430_04",
      activeTab: "logs",
      selectedActionId: "merge",
      actionMessage: null,
    });
  });

  test("preserves selected ids and only validates enum-like runtime values", () => {
    const state = createInitialShellState({
      version: 1,
      selectedRepoId: "repo_bug_fixes",
      selectedWorkspaceId: null,
      selectedTaskId: "task_deleted",
      selectedPtyTabId: "task_deleted:agent",
      inputMode: "control",
      focusedRegion: "missing",
      activeTab: "review",
      selectedActionId: "deploy",
      updatedAt: "2026-05-03T00:00:00.000Z",
    } as unknown as CraigUiRuntime);

    expect(state.focusedRegion).toBe("tasks");
    expect(state.selectedTaskId).toBe("task_deleted");
    expect(state.selectedPtyTabId).toBe("task_deleted:agent");
    expect(state.selectedLeftItemId).toBe("task:task_deleted");
    expect(state.activeTab).toBe("agent");
    expect(state.selectedActionId).toBe("commit");
  });

  test("maps the old tabs focus region to the center pane", () => {
    const state = createInitialShellState({
      version: 1,
      selectedRepoId: "repo_bug_fixes",
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
    const initial = seededState();
    const center = reduceMainKey(initial, "TAB", { leftItemIds: LEFT_ITEM_IDS }).state;
    const actions = reduceMainKey(center, "]", { leftItemIds: LEFT_ITEM_IDS }).state;
    const stillActions = reduceMainKey(actions, "]", { leftItemIds: LEFT_ITEM_IDS }).state;
    const backToCenter = reduceMainKey(stillActions, "[", { leftItemIds: LEFT_ITEM_IDS }).state;

    expect(center.focusedRegion).toBe("center");
    expect(actions.focusedRegion).toBe("actions");
    expect(stillActions.focusedRegion).toBe("actions");
    expect(backToCenter.focusedRegion).toBe("center");
  });

  test("moves task, tab, and action selections through Craig control mode", () => {
    const tasks = seededState();
    const nextTask = reduceMainKey(tasks, "DOWN", { leftItemIds: LEFT_ITEM_IDS }).state;
    const center = reduceMainKey(nextTask, "TAB", { leftItemIds: LEFT_ITEM_IDS }).state;
    const nextTab = reduceMainKey(center, "RIGHT", { leftItemIds: LEFT_ITEM_IDS }).state;
    const actions = reduceMainKey(reduceMainKey(nextTab, "TAB", { leftItemIds: LEFT_ITEM_IDS }).state, "DOWN", { leftItemIds: LEFT_ITEM_IDS }).state;

    expect(nextTask.selectedLeftItemId).toBe("task:task_20260430_03");
    expect(nextTab.activeTab).toBe("files");
    expect(actions.selectedActionId).toBe("push");
  });

  test("enter on the new workspace row requests the workspace browser", () => {
    const state = {
      ...seededState(),
      selectedLeftItemId: "new-workspace",
    };
    const result = reduceMainKey(state, "ENTER", { leftItemIds: LEFT_ITEM_IDS });

    expect(result.openWorkspaceBrowser).toBe(true);
    expect(result.attachTerminal).toBe(false);
    expect(result.state.selectedLeftItemId).toBe("new-workspace");
  });

  test("enter on the new task row opens the task prompt from the left pane", () => {
    const state = {
      ...seededState(),
      selectedLeftItemId: "new-task",
    };
    const result = reduceMainKey(state, "ENTER", { leftItemIds: LEFT_ITEM_IDS });

    expect(result.beginTaskPrompt).toBe(true);
    expect(result.state.taskPromptInput).toBe("");
    expect(result.attachTerminal).toBe(false);
  });

  test("enter on actions emits the current placeholder action message", () => {
    const focusedAction = reduceMainKey(reduceMainKey(seededState(), "TAB", { leftItemIds: LEFT_ITEM_IDS }).state, "TAB", { leftItemIds: LEFT_ITEM_IDS }).state;
    const result = reduceMainKey(focusedAction, "ENTER", { leftItemIds: LEFT_ITEM_IDS });

    expect(result.exit).toBe(false);
    expect(result.pause).toBe(false);
    expect(result.changed).toBe(true);
    expect(result.state.actionMessage).toBe("Action queued: commit (inspection surfaces land in phase 4.1).");
  });

  test("enter on the focused terminal tab attaches terminal mode when a task is selected", () => {
    const center = reduceMainKey(seededState(), "TAB", { leftItemIds: LEFT_ITEM_IDS }).state;
    const terminal = ["RIGHT", "RIGHT", "RIGHT"].reduce(
      (current, key) => reduceMainKey(current, key, { leftItemIds: LEFT_ITEM_IDS }).state,
      center,
    );
    const result = reduceMainKey(terminal, "ENTER", { leftItemIds: LEFT_ITEM_IDS });

    expect(result.attachTerminal).toBe(true);
    expect(result.state.inputMode).toBe("terminal");
    expect(result.state.activeTab).toBe("terminal");
    expect(result.state.selectedTaskId).toBe("task_20260430_02");
  });

  test("enter on a task row in the left pane opens the agent PTY immediately", () => {
    const result = reduceMainKey(seededState(), "ENTER", { leftItemIds: LEFT_ITEM_IDS });

    expect(result.attachTerminal).toBe(true);
    expect(result.state.inputMode).toBe("terminal");
    expect(result.state.activeTab).toBe("agent");
  });

  test("raw carriage return also attaches from the focused terminal tab", () => {
    const center = reduceMainKey(seededState(), "TAB", { leftItemIds: LEFT_ITEM_IDS }).state;
    const terminal = ["RIGHT", "RIGHT", "RIGHT"].reduce(
      (current, key) => reduceMainKey(current, key, { leftItemIds: LEFT_ITEM_IDS }).state,
      center,
    );
    const result = reduceMainKey(terminal, "\r", { leftItemIds: LEFT_ITEM_IDS });

    expect(result.attachTerminal).toBe(true);
    expect(result.state.inputMode).toBe("terminal");
  });

  test("ctrl-m style enter aliases attach from the focused terminal tab", () => {
    const center = reduceMainKey(seededState(), "TAB", { leftItemIds: LEFT_ITEM_IDS }).state;
    const terminal = ["RIGHT", "RIGHT", "RIGHT"].reduce(
      (current, key) => reduceMainKey(current, key, { leftItemIds: LEFT_ITEM_IDS }).state,
      center,
    );

    expect(reduceMainKey(terminal, "CTRL_M", { leftItemIds: LEFT_ITEM_IDS }).attachTerminal).toBe(true);
    expect(reduceMainKey(terminal, "RETURN", { leftItemIds: LEFT_ITEM_IDS }).attachTerminal).toBe(true);
  });

  test("enter does not attach from non-task, non-center regions even if the terminal tab is active", () => {
    const state = {
      ...seededState(),
      focusedRegion: "actions" as const,
      activeTab: "terminal" as const,
    };
    const result = reduceMainKey(state, "ENTER", { leftItemIds: LEFT_ITEM_IDS });

    expect(result.attachTerminal).toBe(false);
    expect(result.state.inputMode).toBe("control");
  });

  test("enter still runs placeholder actions when actions are focused on the terminal tab", () => {
    const state = {
      ...seededState(),
      focusedRegion: "actions" as const,
      activeTab: "terminal" as const,
    };
    const result = reduceMainKey(state, "ENTER", { leftItemIds: LEFT_ITEM_IDS });

    expect(result.attachTerminal).toBe(false);
    expect(result.state.inputMode).toBe("control");
    expect(result.state.actionMessage).toBe("Action queued: commit (inspection surfaces land in phase 4.1).");
  });

  test("ctrl+] detaches terminal mode without losing selected tab or task", () => {
    const attached = {
      ...seededState(),
      inputMode: "terminal" as const,
      activeTab: "terminal" as const,
      selectedTaskId: "task_20260430_04",
    };
    const result = reduceMainKey(attached, "\u001D", { leftItemIds: LEFT_ITEM_IDS });

    expect(result.detachTerminal).toBe(true);
    expect(result.state.inputMode).toBe("control");
    expect(result.state.activeTab).toBe("terminal");
    expect(result.state.selectedTaskId).toBe("task_20260430_04");
  });

  test("non-detach terminal keys are left for the PTY owner", () => {
    const attached = {
      ...seededState(),
      inputMode: "terminal" as const,
      activeTab: "terminal" as const,
    };
    const result = reduceMainKey(attached, "q", { leftItemIds: LEFT_ITEM_IDS });

    expect(result.exit).toBe(false);
    expect(result.changed).toBe(false);
    expect(result.detachTerminal).toBe(false);
    expect(result.state.inputMode).toBe("terminal");
  });

  test("escape always requests pause and clears transient action feedback", () => {
    const focusedAction = reduceMainKey(reduceMainKey(seededState(), "TAB", { leftItemIds: LEFT_ITEM_IDS }).state, "TAB", { leftItemIds: LEFT_ITEM_IDS }).state;
    const withMessage = reduceMainKey(focusedAction, "ENTER", { leftItemIds: LEFT_ITEM_IDS }).state;
    const result = reduceMainKey(withMessage, "ESCAPE", { leftItemIds: LEFT_ITEM_IDS });

    expect(result.pause).toBe(true);
    expect(result.state.actionMessage).toBeNull();
  });

  test("persists only restorable shell selection fields", () => {
    const state = {
      ...seededState(),
      focusedRegion: "actions" as const,
      activeTab: "logs" as const,
      selectedActionId: "merge" as const,
      actionMessage: "transient",
    };

    const persisted = toPersistedUiState(null, state);

    expect(persisted).toMatchObject({
      selectedRepoId: "repo_bug_fixes",
      selectedTaskId: "task_20260430_02",
      selectedPtyTabId: "task_20260430_02:agent",
      inputMode: "control",
      focusedRegion: "actions",
      activeTab: "logs",
      selectedActionId: "merge",
    });
    expect(persisted).not.toHaveProperty("actionMessage");
  });
});

function seededState() {
  return {
    ...createInitialShellState(null),
    selectedRepoId: "repo_bug_fixes",
    selectedTaskId: "task_20260430_02",
    selectedPtyTabId: "task_20260430_02:agent",
    selectedLeftItemId: "task:task_20260430_02",
  };
}
