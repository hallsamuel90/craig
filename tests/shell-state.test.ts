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
const CENTER_TAB_IDS = ["task_20260430_02:agent", "task_20260430_02:terminal", "inspection"];
const PTY_TAB_IDS = ["task_20260430_02:agent", "task_20260430_02:terminal"];
const KEY_OPTIONS = {
  leftItemIds: LEFT_ITEM_IDS,
  centerTabIds: CENTER_TAB_IDS,
  ptyTabIds: PTY_TAB_IDS,
  filePathIds: ["README.md", "src/app.ts"],
  diffPathIds: ["README.md", "src/app.ts"],
};

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
      activeTab: "agent",
      preferredPtyTabKind: "terminal",
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
      activeTab: "agent",
      preferredPtyTabKind: "terminal",
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
    const inspector = reduceMainKey(center, "]", KEY_OPTIONS).state;
    const actions = reduceMainKey(inspector, "]", KEY_OPTIONS).state;
    const stillActions = reduceMainKey(actions, "]", KEY_OPTIONS).state;
    const backToInspector = reduceMainKey(stillActions, "[", KEY_OPTIONS).state;

    expect(center.focusedRegion).toBe("center");
    expect(inspector.focusedRegion).toBe("inspector");
    expect(actions.focusedRegion).toBe("actions");
    expect(actions.inspectorSection).toBe("actions");
    expect(stillActions.focusedRegion).toBe("actions");
    expect(backToInspector.focusedRegion).toBe("inspector");
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
      inspectionMode: "diff",
      openInspectionKind: "diff",
      selectedFilePath: "src/app.ts",
      selectedDiffPath: "src/app.ts",
        selectedActionId: "merge",
        updatedAt: "2026-05-03T00:00:00.000Z",
      }),
      {
        ...restoreModel(),
        inspection: {
          taskId: "task_a_2",
          selectedFilePath: "README.md",
          selectedDiffPath: "README.md",
        },
      },
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
      inspectionMode: "diff",
      openInspectionKind: "diff",
      selectedFilePath: "README.md",
      selectedDiffPath: "README.md",
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
    const actions = reduceMainKey(reduceMainKey(reduceMainKey(nextTab, "TAB", KEY_OPTIONS).state, "TAB", KEY_OPTIONS).state, "DOWN", KEY_OPTIONS).state;

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
    const focusedAction = reduceMainKey(
      reduceMainKey(reduceMainKey(seededState(), "TAB", KEY_OPTIONS).state, "TAB", KEY_OPTIONS).state,
      "TAB",
      KEY_OPTIONS,
    ).state;
    const result = reduceMainKey(focusedAction, "ENTER", KEY_OPTIONS);

    expect(result.exit).toBe(false);
    expect(result.pause).toBe(false);
    expect(result.changed).toBe(true);
    expect(result.state.actionMessage).toBe("Action queued: commit (inspection surfaces land in phase 4.1).");
  });

  test("moves file and diff selections while inspector is focused", () => {
    const files = {
      ...seededState(),
      focusedRegion: "inspector" as const,
      inspectionMode: "files" as const,
      selectedFilePath: "README.md",
    };
    const nextFile = reduceMainKey(files, "DOWN", KEY_OPTIONS);
    const diff = {
      ...seededState(),
      focusedRegion: "inspector" as const,
      inspectionMode: "diff" as const,
      selectedDiffPath: "README.md",
    };
    const nextDiff = reduceMainKey(diff, "DOWN", KEY_OPTIONS);

    expect(nextFile.state.selectedFilePath).toBe("src/app.ts");
    expect(nextFile.refreshInspection).toBe(true);
    expect(nextDiff.state.selectedDiffPath).toBe("src/app.ts");
    expect(nextDiff.refreshInspection).toBe(true);
  });

  test("enter on a selected file directory toggles collapse instead of opening the center", () => {
    const directory = {
      ...seededState(),
      focusedRegion: "inspector" as const,
      inspectionMode: "files" as const,
      selectedFileTreePath: "src",
    };
    const collapsed = reduceMainKey(directory, "ENTER", {
      ...KEY_OPTIONS,
      fileTreeDirectoryIds: ["src"],
      fileTreeRowIds: ["README.md", "src", "src/app.ts"],
      fileTreeFileIds: ["README.md", "src/app.ts"],
    });
    const expanded = reduceMainKey(collapsed.state, "ENTER", {
      ...KEY_OPTIONS,
      fileTreeDirectoryIds: ["src"],
      fileTreeRowIds: ["README.md", "src"],
      fileTreeFileIds: ["README.md"],
    });

    expect(collapsed.state.collapsedFileTreePaths).toEqual(["src"]);
    expect(collapsed.state.activeTab).toBe("task_20260430_02:agent");
    expect(collapsed.refreshInspection).toBe(false);
    expect(expanded.state.collapsedFileTreePaths).toEqual([]);
  });

  test("switching right-panel inspection modes requests fresh local inspection", () => {
    const inspector = {
      ...seededState(),
      focusedRegion: "inspector" as const,
      inspectionMode: "files" as const,
    };
    const diff = reduceMainKey(inspector, "LEFT", KEY_OPTIONS);
    const files = reduceMainKey(diff.state, "RIGHT", KEY_OPTIONS);

    expect(diff.state.inspectionMode).toBe("diff");
    expect(diff.state.activeTab).toBe("inspection");
    expect(diff.state.openInspectionKind).toBe("diff");
    expect(diff.refreshInspection).toBe(true);
    expect(files.state.inspectionMode).toBe("files");
    expect(files.state.activeTab).toBe("inspection");
    expect(files.state.openInspectionKind).toBe("file");
    expect(files.refreshInspection).toBe(true);
  });

  test("switching from an opened file to changes replaces the center with a diff", () => {
    const fileOpen = {
      ...seededState(),
      focusedRegion: "inspector" as const,
      inspectionMode: "files" as const,
      activeTab: "inspection",
      openInspectionKind: "file" as const,
      selectedFilePath: "README.md",
      selectedDiffPath: "README.md",
      fileScrollOffset: 12,
      diffScrollOffset: 8,
    };

    const diff = reduceMainKey(fileOpen, "LEFT", KEY_OPTIONS);

    expect(diff.state.inspectionMode).toBe("diff");
    expect(diff.state.activeTab).toBe("inspection");
    expect(diff.state.openInspectionKind).toBe("diff");
    expect(diff.state.fileScrollOffset).toBe(12);
    expect(diff.state.diffScrollOffset).toBe(0);
  });

  test("right-panel inspection modes include review next to changes and files", () => {
    const files = {
      ...seededState(),
      focusedRegion: "inspector" as const,
      inspectionMode: "files" as const,
    };
    const review = reduceMainKey(files, "RIGHT", KEY_OPTIONS);
    const backToFiles = reduceMainKey(review.state, "LEFT", KEY_OPTIONS);

    expect(review.state.inspectionMode).toBe("review");
    expect(review.refreshInspection).toBe(true);
    expect(backToFiles.state.inspectionMode).toBe("files");
  });

  test("legacy checks and actions inspection modes restore to review", () => {
    const checks = createInitialShellState({
      version: 1,
      selectedRepoId: "repo_bug_fixes",
      selectedWorkspaceId: null,
      selectedTaskId: "task_20260430_02",
      inspectionMode: "checks",
      updatedAt: "2026-05-03T00:00:00.000Z",
    });
    const actions = createInitialShellState({
      version: 1,
      selectedRepoId: "repo_bug_fixes",
      selectedWorkspaceId: null,
      selectedTaskId: "task_20260430_02",
      inspectionMode: "actions",
      updatedAt: "2026-05-03T00:00:00.000Z",
    });

    expect(checks.inspectionMode).toBe("review");
    expect(actions.inspectionMode).toBe("review");
  });

  test("enter on inspector opens the selected inspection mode without attaching a PTY", () => {
    const files = {
      ...seededState(),
      focusedRegion: "inspector" as const,
      inspectionMode: "files" as const,
    };
    const diff = {
      ...files,
      inspectionMode: "diff" as const,
    };

    expect(reduceMainKey(files, "ENTER", KEY_OPTIONS)).toMatchObject({
      state: { activeTab: "inspection", openInspectionKind: "file" },
      attachTerminal: false,
      refreshInspection: true,
      changed: true,
    });
    expect(reduceMainKey(diff, "ENTER", KEY_OPTIONS)).toMatchObject({
      state: { activeTab: "inspection", openInspectionKind: "diff" },
      attachTerminal: false,
      refreshInspection: true,
      changed: true,
    });
  });

  test("enter, P, and R on review request PR actions without attaching a PTY", () => {
    const review = {
      ...seededState(),
      focusedRegion: "inspector" as const,
      inspectionMode: "review" as const,
    };
    const refreshSelected = {
      ...review,
      selectedActionId: "refresh-checks" as const,
    };

    expect(reduceMainKey(review, "ENTER", KEY_OPTIONS)).toMatchObject({
      attachTerminal: false,
      syncPullRequest: true,
      refreshPullRequestChecks: false,
      changed: true,
    });
    expect(reduceMainKey(review, "P", KEY_OPTIONS)).toMatchObject({
      attachTerminal: false,
      syncPullRequest: true,
      state: { selectedActionId: "create-pr" },
      changed: true,
    });
    expect(reduceMainKey(review, "R", KEY_OPTIONS)).toMatchObject({
      attachTerminal: false,
      refreshPullRequestChecks: true,
      state: { selectedActionId: "refresh-checks" },
      changed: true,
    });
    expect(reduceMainKey(refreshSelected, "ENTER", KEY_OPTIONS)).toMatchObject({
      attachTerminal: false,
      syncPullRequest: false,
      refreshPullRequestChecks: true,
      changed: true,
    });
  });

  test("up and down select review actions while review inspector is focused", () => {
    const review = {
      ...seededState(),
      focusedRegion: "inspector" as const,
      inspectionMode: "review" as const,
      selectedActionId: "create-pr" as const,
    };

    const refresh = reduceMainKey(review, "DOWN", KEY_OPTIONS);
    const sync = reduceMainKey(refresh.state, "UP", KEY_OPTIONS);

    expect(refresh.state.selectedActionId).toBe("refresh-checks");
    expect(sync.state.selectedActionId).toBe("create-pr");
  });

  test("scrolls selected file and diff content while center is focused", () => {
    const files = {
      ...reduceMainKey(seededState(), "TAB", KEY_OPTIONS).state,
      activeTab: "inspection",
      openInspectionKind: "file" as const,
      fileScrollOffset: 0,
    };
    const diff = {
      ...files,
      openInspectionKind: "diff" as const,
      diffScrollOffset: 5,
    };

    const nextFile = reduceMainKey(files, "PAGE_DOWN", { ...KEY_OPTIONS, fileLineCount: 40, pageRows: 12 });
    const nextDiff = reduceMainKey(diff, "MOUSE_WHEEL_UP", { ...KEY_OPTIONS, diffLineCount: 40 });

    expect(nextFile.changed).toBe(true);
    expect(nextFile.state.fileScrollOffset).toBe(12);
    expect(nextDiff.changed).toBe(true);
    expect(nextDiff.state.diffScrollOffset).toBe(2);
  });

  test("scrolls file tree and diff rows while inspector is focused", () => {
    const files = {
      ...seededState(),
      focusedRegion: "inspector" as const,
      inspectionMode: "files" as const,
      selectedFileTreePath: "README.md",
      selectedFilePath: "README.md",
    };
    const diff = {
      ...seededState(),
      focusedRegion: "inspector" as const,
      inspectionMode: "diff" as const,
      selectedDiffPath: "README.md",
    };

    const nextFile = reduceMainKey(files, "MOUSE_WHEEL_DOWN", {
      ...KEY_OPTIONS,
      fileTreeRowIds: ["README.md", "src", "src/app.ts", "tests", "tests/app.test.ts"],
      fileTreeFileIds: ["README.md", "src/app.ts", "tests/app.test.ts"],
      fileTreeDirectoryIds: ["src", "tests"],
    });
    const nextDiff = reduceMainKey(diff, "PAGE_DOWN", {
      ...KEY_OPTIONS,
      diffPathIds: ["README.md", "src/app.ts", "tests/app.test.ts", "package.json"],
      pageRows: 2,
    });

    expect(nextFile.changed).toBe(true);
    expect(nextFile.state.selectedFileTreePath).toBe("tests");
    expect(nextFile.state.selectedFilePath).toBe("README.md");
    expect(nextFile.refreshInspection).toBe(false);
    expect(nextDiff.changed).toBe(true);
    expect(nextDiff.state.selectedDiffPath).toBe("tests/app.test.ts");
    expect(nextDiff.refreshInspection).toBe(true);
  });

  test("scroll offset clamps to the last full page instead of the final line", () => {
    const files = {
      ...reduceMainKey(seededState(), "TAB", KEY_OPTIONS).state,
      activeTab: "inspection",
      openInspectionKind: "file" as const,
      fileScrollOffset: 0,
    };

    const nextFile = reduceMainKey(files, "PAGE_DOWN", { ...KEY_OPTIONS, fileLineCount: 15, pageRows: 12 });

    expect(nextFile.state.fileScrollOffset).toBe(3);
  });

  test("changing inspector file or diff selection resets content scroll", () => {
    const files = {
      ...seededState(),
      focusedRegion: "inspector" as const,
      inspectionMode: "files" as const,
      selectedFilePath: "README.md",
      fileScrollOffset: 20,
    };
    const diff = {
      ...seededState(),
      focusedRegion: "inspector" as const,
      inspectionMode: "diff" as const,
      selectedDiffPath: "README.md",
      diffScrollOffset: 20,
    };

    expect(reduceMainKey(files, "DOWN", KEY_OPTIONS).state.fileScrollOffset).toBe(0);
    expect(reduceMainKey(diff, "DOWN", KEY_OPTIONS).state.diffScrollOffset).toBe(0);
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
    expect(result.createPtyTabKind).toBe("agent");
    expect(result.changed).toBe(true);
    expect(result.state.inputMode).toBe("control");
    expect(result.state.preferredPtyTabKind).toBe("agent");
  });

  test("a and t request explicit PTY tab kinds from the focused center pane", () => {
    const center = reduceMainKey(seededState(), "TAB", KEY_OPTIONS).state;
    const agent = reduceMainKey({ ...center, activeTab: "inspection", preferredPtyTabKind: "terminal" }, "a", KEY_OPTIONS);
    const terminal = reduceMainKey({ ...center, activeTab: "inspection", preferredPtyTabKind: "agent" }, "t", KEY_OPTIONS);

    expect(agent.createPtyTab).toBe(true);
    expect(agent.createPtyTabKind).toBe("agent");
    expect(agent.state.preferredPtyTabKind).toBe("agent");
    expect(terminal.createPtyTab).toBe(true);
    expect(terminal.createPtyTabKind).toBe("terminal");
    expect(terminal.state.preferredPtyTabKind).toBe("terminal");
  });

  test("+ falls back to the remembered PTY kind when no concrete tab is active", () => {
    const center = {
      ...reduceMainKey(seededState(), "TAB", KEY_OPTIONS).state,
      activeTab: "inspection",
      selectedPtyTabId: null,
      preferredPtyTabKind: "terminal" as const,
    };
    const result = reduceMainKey(center, "+", { ...KEY_OPTIONS, ptyTabIds: [] });

    expect(result.createPtyTab).toBe(true);
    expect(result.createPtyTabKind).toBe("terminal");
    expect(result.state.preferredPtyTabKind).toBe("terminal");
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

  test("x on a focused inspection center surface does not close anything", () => {
    const inspection = {
      ...reduceMainKey(seededState(), "TAB", KEY_OPTIONS).state,
      activeTab: "inspection",
    };
    const result = reduceMainKey(inspection, "x", KEY_OPTIONS);

    expect(result.closePtyTab).toBe(false);
    expect(result.changed).toBe(false);
    expect(result.state.activeTab).toBe("inspection");
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
      activeTab: "task_20260430_02:agent" as const,
      inspectorSection: "actions" as const,
      inspectionMode: "diff" as const,
      openInspectionKind: "diff" as const,
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
      activeTab: "task_20260430_02:agent",
      preferredPtyTabKind: "agent",
      inspectorSection: "actions",
      inspectionMode: "diff",
      openInspectionKind: "diff",
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
