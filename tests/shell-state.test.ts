import { describe, expect, test } from "vitest";

import type { CraigUiRuntime } from "../src/types/workspace.js";
import { createInitialShellState, reduceMainKey, restoreShellState, toPersistedUiState } from "../src/ui/state.js";
import { buildTaskRecord } from "./test-helpers.js";

const LEFT_ITEM_IDS = [
  "repo:repo_bug_fixes",
  "task:task_20260430_02",
  "task:task_20260430_03",
  "repo:repo_testing",
  "task:task_20260430_04",
  "new-task",
  "new-workspace",
];
const CENTER_TAB_IDS = ["task_20260430_02:agent", "task_20260430_02:terminal", "files", "diff", "logs"];
const PTY_TAB_IDS = ["task_20260430_02:agent", "task_20260430_02:terminal"];
const KEY_OPTIONS = { leftItemIds: LEFT_ITEM_IDS, centerTabIds: CENTER_TAB_IDS, ptyTabIds: PTY_TAB_IDS };

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
      inspectorSection: "checks",
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
      inspectorSection: "checks",
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
      inspectorSection: "missing",
      selectedActionId: "deploy",
      updatedAt: "2026-05-03T00:00:00.000Z",
    } as unknown as CraigUiRuntime);

    expect(state.focusedRegion).toBe("tasks");
    expect(state.selectedTaskId).toBe("task_deleted");
    expect(state.selectedPtyTabId).toBe("task_deleted:agent");
    expect(state.selectedLeftItemId).toBe("task:task_deleted");
    expect(state.activeTab).toBe("review");
    expect(state.inspectorSection).toBe("task");
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
      activeTab: "task_a_2:terminal",
      inspectorSection: "task",
      selectedActionId: "commit",
      updatedAt: "2026-05-03T00:00:00.000Z",
    });

    expect(state.focusedRegion).toBe("center");
  });

  test("cycles focus with tab-style keys and clamps at region edges", () => {
    const initial = seededState();
    const center = reduceMainKey(initial, "TAB", KEY_OPTIONS).state;
    const actions = reduceMainKey(center, "]", KEY_OPTIONS).state;
    const stillActions = reduceMainKey(actions, "]", KEY_OPTIONS).state;
    const backToCenter = reduceMainKey(stillActions, "[", KEY_OPTIONS).state;

    expect(center.focusedRegion).toBe("center");
    expect(actions.focusedRegion).toBe("actions");
    expect(actions.inspectorSection).toBe("actions");
    expect(stillActions.focusedRegion).toBe("actions");
    expect(backToCenter.focusedRegion).toBe("center");
  });

  test("restores valid persisted repo, task, terminal tab, and inspector orientation", () => {
    const state = restoreShellState(
      createInitialShellState({
        version: 1,
        selectedRepoId: "repo_a",
        selectedWorkspaceId: "workspace_repo_a",
        selectedTaskId: "task_a_2",
        selectedPtyTabId: "task_a_2:terminal",
        inputMode: "control",
        focusedRegion: "center",
        activeTab: "terminal",
        inspectorSection: "next-action",
        selectedActionId: "merge",
        updatedAt: "2026-05-03T00:00:00.000Z",
      }),
      restoreModel(),
    );

    expect(state).toMatchObject({
      inputMode: "control",
      focusedRegion: "center",
      selectedRepoId: "repo_a",
      selectedTaskId: "task_a_2",
      selectedPtyTabId: "task_a_2:terminal",
      selectedLeftItemId: "task:task_a_2",
      activeTab: "task_a_2:terminal",
      inspectorSection: "next-action",
      selectedActionId: "merge",
    });
  });

  test("falls back safely when persisted repo, task, and PTY tab ids are stale", () => {
    const state = restoreShellState(
      createInitialShellState({
        version: 1,
        selectedRepoId: "repo_deleted",
        selectedWorkspaceId: "workspace_repo_deleted",
        selectedTaskId: "task_deleted",
        selectedPtyTabId: "task_deleted:terminal",
        inputMode: "control",
        focusedRegion: "center",
        activeTab: "terminal",
        selectedActionId: "commit",
        updatedAt: "2026-05-03T00:00:00.000Z",
      }),
      restoreModel(),
    );

    expect(state.selectedRepoId).toBe("repo_a");
    expect(state.selectedTaskId).toBe("task_a_1");
    expect(state.selectedPtyTabId).toBe("task_a_1:terminal");
    expect(state.inputMode).toBe("control");
    expect(state.inspectorSection).toBe("task");
  });

  test("restores terminal mode requests as control mode", () => {
    const state = restoreShellState(
      {
        ...createInitialShellState({
          version: 1,
          selectedRepoId: "repo_a",
          selectedWorkspaceId: "workspace_repo_a",
          selectedTaskId: "task_a_1",
          selectedPtyTabId: "task_a_1:agent",
          inputMode: "control",
          focusedRegion: "center",
          activeTab: "agent",
          inspectorSection: "task",
          selectedActionId: "commit",
          updatedAt: "2026-05-03T00:00:00.000Z",
        }),
        inputMode: "terminal",
      },
      restoreModel(),
      { resetInputMode: true },
    );

    expect(state.inputMode).toBe("control");
    expect(state.selectedPtyTabId).toBe("task_a_1:agent");
  });

  test("moves task, tab, and action selections through Craig control mode", () => {
    const tasks = seededState();
    const nextTask = reduceMainKey(tasks, "DOWN", KEY_OPTIONS).state;
    const center = reduceMainKey(nextTask, "TAB", KEY_OPTIONS).state;
    const nextTab = reduceMainKey(center, "RIGHT", KEY_OPTIONS).state;
    const actions = reduceMainKey(reduceMainKey(nextTab, "TAB", KEY_OPTIONS).state, "DOWN", KEY_OPTIONS).state;

    expect(nextTask.selectedLeftItemId).toBe("task:task_20260430_03");
    expect(nextTab.activeTab).toBe("task_20260430_02:terminal");
    expect(actions.selectedActionId).toBe("push");
  });

  test("enter on the new workspace row requests the workspace browser", () => {
    const state = {
      ...seededState(),
      selectedLeftItemId: "new-workspace",
    };
    const result = reduceMainKey(state, "ENTER", KEY_OPTIONS);

    expect(result.openWorkspaceBrowser).toBe(true);
    expect(result.attachTerminal).toBe(false);
    expect(result.state.selectedLeftItemId).toBe("new-workspace");
  });

  test("enter on the new task row opens the task prompt from the left pane", () => {
    const state = {
      ...seededState(),
      selectedLeftItemId: "new-task",
    };
    const result = reduceMainKey(state, "ENTER", KEY_OPTIONS);

    expect(result.beginTaskPrompt).toBe(true);
    expect(result.state.taskPromptInput).toBe("");
    expect(result.attachTerminal).toBe(false);
  });

  test("enter on actions emits the current placeholder action message", () => {
    const focusedAction = reduceMainKey(reduceMainKey(seededState(), "TAB", KEY_OPTIONS).state, "TAB", KEY_OPTIONS).state;
    const result = reduceMainKey(focusedAction, "ENTER", KEY_OPTIONS);

    expect(result.exit).toBe(false);
    expect(result.pause).toBe(false);
    expect(result.changed).toBe(true);
    expect(result.state.actionMessage).toBe("Action queued: commit (inspection surfaces land in phase 4.1).");
  });

  test("enter on the focused terminal tab attaches terminal mode when a task is selected", () => {
    const terminal = {
      ...reduceMainKey(seededState(), "TAB", KEY_OPTIONS).state,
      activeTab: "task_20260430_02:terminal",
      selectedPtyTabId: "task_20260430_02:terminal",
    };
    const result = reduceMainKey(terminal, "ENTER", KEY_OPTIONS);

    expect(result.attachTerminal).toBe(true);
    expect(result.state.inputMode).toBe("terminal");
    expect(result.state.activeTab).toBe("task_20260430_02:terminal");
    expect(result.state.selectedTaskId).toBe("task_20260430_02");
  });

  test("+ on the focused center pane requests a new PTY tab", () => {
    const center = reduceMainKey(seededState(), "TAB", KEY_OPTIONS).state;
    const result = reduceMainKey(center, "+", KEY_OPTIONS);

    expect(result.createPtyTab).toBe(true);
    expect(result.changed).toBe(true);
    expect(result.state.inputMode).toBe("control");
  });

  test("x on a focused concrete PTY tab requests tab close", () => {
    const terminal = {
      ...reduceMainKey(seededState(), "TAB", KEY_OPTIONS).state,
      activeTab: "task_20260430_02:terminal",
      selectedPtyTabId: "task_20260430_02:terminal",
    };
    const result = reduceMainKey(terminal, "x", KEY_OPTIONS);

    expect(result.closePtyTab).toBe(true);
    expect(result.changed).toBe(true);
    expect(result.state.inputMode).toBe("control");
  });

  test("x on a focused fixed center surface does not close anything", () => {
    const files = {
      ...reduceMainKey(seededState(), "TAB", KEY_OPTIONS).state,
      activeTab: "files",
    };
    const result = reduceMainKey(files, "x", KEY_OPTIONS);

    expect(result.closePtyTab).toBe(false);
    expect(result.changed).toBe(false);
    expect(result.state.activeTab).toBe("files");
  });

  test("enter on a task row in the left pane opens the agent PTY immediately", () => {
    const result = reduceMainKey(seededState(), "ENTER", KEY_OPTIONS);

    expect(result.attachTerminal).toBe(true);
    expect(result.state.inputMode).toBe("terminal");
    expect(result.state.activeTab).toBe("task_20260430_02:agent");
  });

  test("raw carriage return also attaches from the focused terminal tab", () => {
    const terminal = {
      ...reduceMainKey(seededState(), "TAB", KEY_OPTIONS).state,
      activeTab: "task_20260430_02:terminal",
      selectedPtyTabId: "task_20260430_02:terminal",
    };
    const result = reduceMainKey(terminal, "\r", KEY_OPTIONS);

    expect(result.attachTerminal).toBe(true);
    expect(result.state.inputMode).toBe("terminal");
  });

  test("ctrl-m style enter aliases attach from the focused terminal tab", () => {
    const terminal = {
      ...reduceMainKey(seededState(), "TAB", KEY_OPTIONS).state,
      activeTab: "task_20260430_02:terminal",
      selectedPtyTabId: "task_20260430_02:terminal",
    };

    expect(reduceMainKey(terminal, "CTRL_M", KEY_OPTIONS).attachTerminal).toBe(true);
    expect(reduceMainKey(terminal, "RETURN", KEY_OPTIONS).attachTerminal).toBe(true);
  });

  test("enter does not attach from non-task, non-center regions even if the terminal tab is active", () => {
    const state = {
      ...seededState(),
      focusedRegion: "actions" as const,
      activeTab: "task_20260430_02:terminal",
    };
    const result = reduceMainKey(state, "ENTER", KEY_OPTIONS);

    expect(result.attachTerminal).toBe(false);
    expect(result.state.inputMode).toBe("control");
  });

  test("enter still runs placeholder actions when actions are focused on the terminal tab", () => {
    const state = {
      ...seededState(),
      focusedRegion: "actions" as const,
      activeTab: "task_20260430_02:terminal",
    };
    const result = reduceMainKey(state, "ENTER", KEY_OPTIONS);

    expect(result.attachTerminal).toBe(false);
    expect(result.state.inputMode).toBe("control");
    expect(result.state.actionMessage).toBe("Action queued: commit (inspection surfaces land in phase 4.1).");
  });

  test("ctrl+] detaches terminal mode without losing selected tab or task", () => {
    const attached = {
      ...seededState(),
      inputMode: "terminal" as const,
      activeTab: "task_20260430_02:terminal",
      selectedTaskId: "task_20260430_04",
    };
    const result = reduceMainKey(attached, "\u001D", KEY_OPTIONS);

    expect(result.detachTerminal).toBe(true);
    expect(result.state.inputMode).toBe("control");
    expect(result.state.activeTab).toBe("task_20260430_02:terminal");
    expect(result.state.selectedTaskId).toBe("task_20260430_04");
  });

  test("non-detach terminal keys are left for the PTY owner", () => {
    const attached = {
      ...seededState(),
      inputMode: "terminal" as const,
      activeTab: "task_20260430_02:terminal",
    };
    const result = reduceMainKey(attached, "q", KEY_OPTIONS);

    expect(result.exit).toBe(false);
    expect(result.changed).toBe(false);
    expect(result.detachTerminal).toBe(false);
    expect(result.state.inputMode).toBe("terminal");
  });

  test("escape always requests pause and clears transient action feedback", () => {
    const focusedAction = reduceMainKey(reduceMainKey(seededState(), "TAB", KEY_OPTIONS).state, "TAB", KEY_OPTIONS).state;
    const withMessage = reduceMainKey(focusedAction, "ENTER", KEY_OPTIONS).state;
    const result = reduceMainKey(withMessage, "ESCAPE", KEY_OPTIONS);

    expect(result.pause).toBe(true);
    expect(result.state.actionMessage).toBeNull();
  });

  test("persists only restorable shell selection fields", () => {
    const state = {
      ...seededState(),
      focusedRegion: "actions" as const,
      activeTab: "logs" as const,
      inspectorSection: "actions" as const,
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
      inspectorSection: "actions",
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
    activeTab: "task_20260430_02:agent",
  };
}

function restoreModel() {
  return {
    repos: [
      {
        id: "repo_a",
        name: "repo-a",
        rootPath: "/tmp/repo-a",
        defaultBranch: "main",
        createdAt: "2026-05-03T00:00:00.000Z",
        updatedAt: "2026-05-03T00:00:00.000Z",
      },
      {
        id: "repo_b",
        name: "repo-b",
        rootPath: "/tmp/repo-b",
        defaultBranch: "main",
        createdAt: "2026-05-03T00:00:00.000Z",
        updatedAt: "2026-05-03T00:00:00.000Z",
      },
    ],
    tasks: [
      buildTaskRecord("/tmp/repo-a", {
        id: "task_a_1",
        repoId: "repo_a",
        workspaceId: "workspace_repo_a",
      }),
      buildTaskRecord("/tmp/repo-a", {
        id: "task_a_2",
        repoId: "repo_a",
        workspaceId: "workspace_repo_a",
      }),
      buildTaskRecord("/tmp/repo-b", {
        id: "task_b_1",
        repoId: "repo_b",
        workspaceId: "workspace_repo_b",
      }),
    ],
  };
}
