import type { CenterTabId, ControlShellState, FocusRegion, MockActionId, MockTaskId } from "./state.js";

export interface MockTopRail {
  workspacePath: string;
  agent: string;
  liveLabel: string;
}

export interface MockTreeRow {
  text: string;
  taskId?: MockTaskId;
  indent?: number;
  selected?: boolean;
  focused?: boolean;
  accentDot?: boolean;
  status?: string;
  muted?: boolean;
}

export interface MockRunnerRow {
  name: string;
  meter: string;
  count: string;
}

export interface MockTab {
  id: CenterTabId;
  label: string;
  active?: boolean;
  focused?: boolean;
}

export interface MockContextRow {
  label: string;
  value: string;
  mutedValue?: boolean;
}

export interface MockCheckRow {
  status: string;
  label: string;
  result: string;
  duration: string;
  success?: boolean;
}

export interface MockActionRow {
  id: MockActionId;
  label: string;
  shortcut: string;
  selected?: boolean;
  focused?: boolean;
}

export interface MockShellData {
  focusedRegion: FocusRegion;
  actionMessage: string | null;
  topRail: MockTopRail;
  leftTree: MockTreeRow[];
  runners: MockRunnerRow[];
  centerHeader: {
    tabLabel: string;
    taskId: string;
    repo: string;
    agent: string;
  };
  centerTranscript: string[];
  tabs: MockTab[];
  rightContext: MockContextRow[];
  rightChecks: MockCheckRow[];
  rightActions: MockActionRow[];
  rightNextAction: string;
}

export function getMockShellData(
  state: Pick<ControlShellState, "focusedRegion" | "selectedTaskId" | "activeTab" | "selectedActionId" | "actionMessage"> = {
    focusedRegion: "tasks",
    selectedTaskId: "task_20260430_02",
    activeTab: "agent",
    selectedActionId: "commit",
    actionMessage: null,
  },
): MockShellData {
  const selectedTask = TASK_FIXTURES.find((task) => task.id === state.selectedTaskId) ?? TASK_FIXTURES[1]!;
  const activeTab = TAB_FIXTURES.find((tab) => tab.id === state.activeTab) ?? TAB_FIXTURES[0]!;

  return {
    focusedRegion: state.focusedRegion,
    actionMessage: state.actionMessage,
    topRail: {
      workspacePath: "~/workspaces/craig/colombo",
      agent: "codex",
      liveLabel: "live",
    },
    leftTree: [
      { text: "WORKSPACES", muted: true, focused: state.focusedRegion === "tasks" },
      { text: "▾ craig" },
      { text: "▾ main", indent: 2 },
      taskTreeRow("task_20260430_01", 4, "└", state),
      { text: "▾ bug-fixes", indent: 2 },
      taskTreeRow("task_20260430_02", 1, "▸", state),
      taskTreeRow("task_20260430_03", 6, "", state),
      { text: "▾ what-up-dennys", indent: 2 },
      taskTreeRow("task_20260430_06", 4, "└", state, true),
      { text: "▾ testing", indent: 2 },
      taskTreeRow("task_20260430_04", 4, "└", state, true),
      { text: "▾ whats-our-test-coverage", indent: 2 },
      taskTreeRow("task_20260430_05", 4, "└", state, true),
    ],
    runners: [
      { name: "codex", meter: "[##########]", count: "6" },
      { name: "cursor", meter: "[##########]", count: "2" },
    ],
    centerHeader: {
      tabLabel: activeTab.label,
      taskId: selectedTask.id,
      repo: selectedTask.repo,
      agent: "codex",
    },
    centerTranscript: getCenterTranscript(state.activeTab),
    tabs: TAB_FIXTURES.map((tab) => ({
      ...tab,
      active: tab.id === state.activeTab,
      focused: state.focusedRegion === "tabs" && tab.id === state.activeTab,
    })),
    rightContext: [
      { label: "Task", value: selectedTask.id },
      { label: "Repo", value: selectedTask.repo },
      { label: "Agent", value: "codex" },
      { label: "Branch", value: selectedTask.branch },
      { label: "Started", value: "20:18:42" },
      { label: "Status", value: selectedTask.status },
      { label: "Changes", value: "+3    -2" },
    ],
    rightChecks: [
      { status: "✓", label: "Lint", result: "OK", duration: "5s", success: true },
      { status: "✓", label: "Typecheck", result: "OK", duration: "7s", success: true },
      { status: "✓", label: "Tests", result: "OK", duration: "12s", success: true },
      { status: "○", label: "Build", result: "pending", duration: "--" },
      { status: "○", label: "Docker Build", result: "pending", duration: "--" },
    ],
    rightActions: ACTION_FIXTURES.map((action) => ({
      ...action,
      selected: action.id === state.selectedActionId,
      focused: state.focusedRegion === "actions" && action.id === state.selectedActionId,
    })),
    rightNextAction: "Run the build, then open the PR.",
  };
}

const TASK_FIXTURES: Array<{
  id: MockTaskId;
  repo: string;
  branch: string;
  status: string;
}> = [
  { id: "task_20260430_01", repo: "main", branch: "task/remove-old-shell", status: "done" },
  { id: "task_20260430_02", repo: "bug-fixes", branch: "task/interactive-shell", status: "running" },
  { id: "task_20260430_03", repo: "bug-fixes", branch: "task/panel-polish", status: "queued" },
  { id: "task_20260430_04", repo: "testing", branch: "task/test-cleanup", status: "done" },
  { id: "task_20260430_05", repo: "whats-our-test-coverage", branch: "task/coverage", status: "queued" },
  { id: "task_20260430_06", repo: "what-up-dennys", branch: "task/dennys", status: "queued" },
];

const TAB_FIXTURES: Array<{ id: CenterTabId; label: string }> = [
  { id: "agent", label: "AGENT" },
  { id: "files", label: "FILES" },
  { id: "diff", label: "DIFF" },
  { id: "terminal", label: "TERMINAL" },
  { id: "logs", label: "LOGS" },
];

const ACTION_FIXTURES: Array<{ id: MockActionId; label: string; shortcut: string }> = [
  { id: "commit", label: "commit", shortcut: "c" },
  { id: "push", label: "push", shortcut: "p" },
  { id: "create-pr", label: "create pr", shortcut: "P" },
  { id: "merge", label: "merge", shortcut: "m" },
  { id: "close-task", label: "close task", shortcut: "x" },
];

function taskTreeRow(
  taskId: MockTaskId,
  indent: number,
  prefix: string,
  state: Pick<ControlShellState, "focusedRegion" | "selectedTaskId">,
  muted = false,
): MockTreeRow {
  const selected = taskId === state.selectedTaskId;
  const task = TASK_FIXTURES.find((fixture) => fixture.id === taskId) ?? TASK_FIXTURES[1]!;
  const rowPrefix = selected ? "▸" : prefix;
  const text = `${rowPrefix ? `${rowPrefix} ` : ""}${taskId}`;
  const row: MockTreeRow = {
    taskId,
    text,
    indent,
    muted: muted && !selected,
    selected,
    focused: selected && state.focusedRegion === "tasks",
    accentDot: selected && task.status === "running",
  };

  if (selected) {
    row.status = task.status;
  }

  return row;
}

function getCenterTranscript(tabId: CenterTabId): string[] {
  if (tabId === "agent") {
    return [
      "codex ▸ Refactor the interactive shell renderer to remove",
      "the native input bar and smoke test it.",
      "",
      "codex ▸ plan",
      "  1. Remove native input bar from app.tsx              ✓",
      "  2. Move tests to renderer/runtime path               ✓",
      "  3. Add smoke tests for full repo gates               ○",
      "",
      "codex ▸ run",
      "  ✓ Updated src/interactive/app.tsx",
      "  ✓ Updated src/interactive/render.ts",
      "  ○ Added src/interactive/render.test.ts",
      "  ○ Running tests... (12s)",
      "",
      "codex ▸",
    ];
  }

  const labels: Record<CenterTabId, string> = {
    agent: "Agent transcript",
    files: "Files changed",
    diff: "Diff preview",
    terminal: "Terminal session",
    logs: "Task logs",
  };

  return [
    `codex ▸ ${labels[tabId]} placeholder.`,
    "",
    "Selected by Craig control mode.",
    "Live data arrives in later RFC phases.",
    "",
    "codex ▸",
  ];
}
