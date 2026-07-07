import type { ControlShellState } from "./state.js";
import type { ShellData, ShellTreeRow } from "./shell/data.js";

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
    | "footerToast"
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
    modalInput: resolved.taskPromptInput !== null || resolved.workspaceBrowser !== null,
    focusedRegion: resolved.focusedRegion,
    actionMessage: resolved.actionMessage,
    footerToast: resolved.footerToast,
    terminal: resolved.terminal,
    footerText:
      resolved.taskPromptInput !== null
        ? `NEW TASK [${selectedRepo.name}] · codex   Ctrl+R switch runner   Enter create   Esc cancel   ›   ${resolved.taskPromptInput}${resolved.taskPromptError ? `   ✗ ${resolved.taskPromptError}` : ""}`
        : resolved.inputMode === "terminal"
        ? "TERMINAL   ↑↓/PgUp/PgDn scroll   Ctrl+] return to control"
        : resolved.focusedRegion === "tasks"
        ? "n new task   Enter attach   X close task   Esc pause   ? help"
        : "n new task   Esc pause   ? help",
    topRail: {
      workspacePath: "~/workspaces/craig/colombo",
      agent: "codex",
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
  | "footerToast"
  | "taskPromptInput"
  | "taskPromptError"
  | "workspaceBrowser"
  | "terminal"
  | "centerZoomed"
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
  footerToast: null,
  taskPromptInput: null,
  taskPromptError: null,
  workspaceBrowser: null,
  terminal: {
    status: "idle",
    rows: [],
    error: null,
  },
  centerZoomed: false,
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
