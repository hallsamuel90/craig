import type { ControlShellState } from "./state.js";
import type { ShellData, ShellTreeRow } from "./shell-data.js";

type MockShellStateInput = Partial<
  Pick<
    ControlShellState,
    | "inputMode"
    | "focusedRegion"
    | "selectedRepoId"
    | "selectedTaskId"
    | "selectedPtyTabId"
    | "selectedLeftItemId"
    | "activeTab"
    | "inspectionMode"
    | "openInspectionKind"
    | "selectedActionId"
    | "actionMessage"
    | "taskPromptInput"
    | "taskPromptError"
    | "workspaceBrowser"
    | "terminal"
  >
>;

export function getMockShellData(state: MockShellStateInput = {}): ShellData {
  const resolved = {
    ...DEFAULT_MOCK_SHELL_STATE,
    ...state,
    terminal: {
      ...DEFAULT_MOCK_SHELL_STATE.terminal,
      ...state.terminal,
    },
  };

  const selectedTask = TASK_FIXTURES.find((task) => task.id === resolved.selectedTaskId) ?? TASK_FIXTURES[1]!;
  const selectedRepo = REPO_FIXTURES.find((repo) => repo.id === resolved.selectedRepoId) ?? REPO_FIXTURES[1]!;
  const activeTab = TAB_FIXTURES.find((tab) => tab.id === resolved.activeTab) ?? TAB_FIXTURES[0]!;

  return {
    inputMode: resolved.inputMode,
    focusedRegion: resolved.focusedRegion,
    actionMessage: resolved.actionMessage,
    terminal: resolved.terminal,
    footerText:
      resolved.taskPromptInput !== null
        ? `NEW TASK [${selectedRepo.name}]: ${resolved.taskPromptInput}${resolved.taskPromptError ? ` · ${resolved.taskPromptError}` : ""}`
        : resolved.inputMode === "terminal"
        ? "TERMINAL   Ctrl+] detach   wheel/PgUp/PgDn scroll"
        : "NORMAL   n new task   ? help   / search   : command",
    topRail: {
      workspacePath: "~/workspaces/craig/colombo",
      agent: "codex",
      liveLabel: "live",
    },
    leftTree: [
      { text: "WORKSPACES", muted: true, focused: resolved.focusedRegion === "tasks" },
      { text: "▾ main" },
      taskTreeRow("task_20260430_01", 2, "└", resolved),
      { text: "▾ bug-fixes" },
      taskTreeRow("task_20260430_02", 2, "▸", resolved),
      taskTreeRow("task_20260430_03", 2, "•", resolved),
      { text: "▾ testing" },
      taskTreeRow("task_20260430_04", 2, "└", resolved),
      { text: "▾ whats-our-test-coverage" },
      taskTreeRow("task_20260430_05", 2, "└", resolved),
      { text: "▾ what-up-dennys" },
      taskTreeRow("task_20260430_06", 2, "└", resolved),
      { text: "" },
      {
        id: "new-task",
        text: "+ New Task",
        selected: resolved.selectedLeftItemId === "new-task",
        focused: resolved.focusedRegion === "tasks" && resolved.selectedLeftItemId === "new-task",
      },
      {
        id: "new-workspace",
        text: "+ New Workspace",
        selected: resolved.selectedLeftItemId === "new-workspace",
        focused: resolved.focusedRegion === "tasks" && resolved.selectedLeftItemId === "new-workspace",
      },
    ],
    runners: [
      { name: "codex", health: 1.0, count: "6" },
      { name: "cursor", health: 0.3, count: "2" },
    ],
    centerHeader: {
      tabLabel: activeTab.label,
      taskId: selectedTask.id,
      repo: selectedTask.repo,
      agent: "codex",
    },
    centerTranscript: getCenterTranscript(resolved.activeTab, selectedTask.id),
    tabs: TAB_FIXTURES.map((tab) => ({
      ...tab,
      active: tab.id === resolved.activeTab,
      focused: resolved.focusedRegion === "center" && tab.id === resolved.activeTab,
    })),
    rightContext: [
      { label: "Task", value: selectedTask.id },
      { label: "Repo", value: selectedTask.repo },
      { label: "Agent", value: "codex" },
      { label: "Branch", value: selectedTask.branch },
      { label: "Status", value: selectedTask.status },
      { label: "Worktree", value: selectedTask.id },
    ],
    rightInspection: null,
    rightChecks: [
      { status: "✓", label: "Checks", result: "passed", duration: "done", success: true },
      { status: "✓", label: "Runner", result: "running", duration: "live", success: true },
    ],
    rightActions: ACTION_FIXTURES.map((action) => ({
      ...action,
      selected: action.id === resolved.selectedActionId,
      focused: resolved.focusedRegion === "actions" && action.id === resolved.selectedActionId,
    })),
  };
}

const DEFAULT_MOCK_SHELL_STATE: Pick<
  ControlShellState,
  | "inputMode"
  | "focusedRegion"
  | "selectedRepoId"
  | "selectedTaskId"
  | "selectedPtyTabId"
  | "selectedLeftItemId"
  | "activeTab"
  | "inspectionMode"
  | "openInspectionKind"
  | "selectedActionId"
  | "actionMessage"
  | "taskPromptInput"
  | "taskPromptError"
  | "workspaceBrowser"
  | "terminal"
> = {
  inputMode: "control",
  focusedRegion: "tasks",
  selectedRepoId: "repo_bug_fixes",
  selectedTaskId: "task_20260430_02",
  selectedPtyTabId: "task_20260430_02:agent",
  selectedLeftItemId: "task:task_20260430_02",
  activeTab: "agent",
  inspectionMode: "files",
  openInspectionKind: null,
  selectedActionId: "commit",
  actionMessage: null,
  taskPromptInput: null,
  taskPromptError: null,
  workspaceBrowser: null,
  terminal: {
    status: "idle",
    rows: [],
    error: null,
  },
};

const REPO_FIXTURES = [
  { id: "repo_main", name: "main" },
  { id: "repo_bug_fixes", name: "bug-fixes" },
  { id: "repo_testing", name: "testing" },
  { id: "repo_coverage", name: "whats-our-test-coverage" },
  { id: "repo_dennys", name: "what-up-dennys" },
] as const;

const TASK_FIXTURES = [
  { id: "task_20260430_01", repo: "main", branch: "task/remove-old-shell", status: "done" },
  { id: "task_20260430_02", repo: "bug-fixes", branch: "task/interactive-shell", status: "running" },
  { id: "task_20260430_03", repo: "bug-fixes", branch: "task/panel-polish", status: "queued" },
  { id: "task_20260430_04", repo: "testing", branch: "task/test-cleanup", status: "done" },
  { id: "task_20260430_05", repo: "whats-our-test-coverage", branch: "task/coverage", status: "queued" },
  { id: "task_20260430_06", repo: "what-up-dennys", branch: "task/dennys", status: "queued" },
] as const;

const TAB_FIXTURES = [
  { id: "agent", label: "AGENT" },
  { id: "terminal", label: "TERMINAL" },
] as const;

const ACTION_FIXTURES = [
  { id: "commit", label: "commit", shortcut: "c" },
  { id: "push", label: "push", shortcut: "p" },
  { id: "create-pr", label: "create pr", shortcut: "P" },
  { id: "refresh-checks", label: "refresh checks", shortcut: "R" },
  { id: "merge", label: "merge", shortcut: "m" },
  { id: "close-task", label: "close task", shortcut: "x" },
] as const;

function taskTreeRow(
  taskId: string,
  indent: number,
  prefix: string,
  state: Pick<ControlShellState, "focusedRegion" | "selectedTaskId">,
) {
  const selected = taskId === state.selectedTaskId;
  const task = TASK_FIXTURES.find((fixture) => fixture.id === taskId) ?? TASK_FIXTURES[1]!;
  const rowPrefix = selected ? "▸" : prefix;
  const row: ShellTreeRow = {
    id: `task:${taskId}`,
    taskId,
    text: `${rowPrefix} ${taskId}`,
    indent,
    selected,
    focused: selected && state.focusedRegion === "tasks",
    accentDot: selected && task.status === "running",
  };
  if (selected) {
    row.status = task.status;
  }
  return row;
}

function getCenterTranscript(tabId: ControlShellState["activeTab"], taskId: string) {
  if (tabId === "agent") {
    return [
      `Codex agent tab ready for ${taskId}.`,
      "",
      "Press Enter to attach the live PTY-backed agent session.",
    ].map((line) => ({ text: line }));
  }

  return [{ text: `${tabId === "terminal" ? "Plain terminal tab" : "Center tab"} placeholder for ${taskId}.` }];
}
