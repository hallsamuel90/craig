import path from "node:path";

import type { TaskPtyTabRecord, TaskRecord } from "../types/task.js";
import type { RepoRecord } from "../types/workspace.js";
import { FIXED_CENTER_TAB_IDS } from "./state.js";
import type {
  ActionId,
  CenterTabId,
  ControlShellState,
  FocusRegion,
  InputMode,
  TerminalViewState,
  WorkspaceBrowserState,
} from "./state.js";

export interface ShellTopRail {
  workspacePath: string;
  agent: string;
  liveLabel: string;
}

export interface ShellTreeRow {
  id?: string;
  text: string;
  taskId?: string;
  indent?: number;
  selected?: boolean;
  focused?: boolean;
  accentDot?: boolean;
  status?: string;
  muted?: boolean;
}

export interface ShellRunnerRow {
  name: string;
  meter: string;
  count: string;
}

export interface ShellTab {
  id: CenterTabId;
  label: string;
  active?: boolean;
  focused?: boolean;
}

export interface ShellContextRow {
  label: string;
  value: string;
  mutedValue?: boolean;
}

export interface ShellCheckRow {
  status: string;
  label: string;
  result: string;
  duration: string;
  success?: boolean;
}

export interface ShellActionRow {
  id: ActionId;
  label: string;
  shortcut: string;
  selected?: boolean;
  focused?: boolean;
}

export interface ShellData {
  inputMode: InputMode;
  focusedRegion: FocusRegion;
  actionMessage: string | null;
  terminal: TerminalViewState;
  footerText: string;
  topRail: ShellTopRail;
  leftTree: ShellTreeRow[];
  runners: ShellRunnerRow[];
  centerHeader: {
    tabLabel: string;
    taskId: string;
    repo: string;
    agent: string;
  };
  centerTranscript: string[];
  tabs: ShellTab[];
  rightContext: ShellContextRow[];
  rightChecks: ShellCheckRow[];
  rightActions: ShellActionRow[];
  rightNextAction: string;
}

export interface WorkspaceShellModel {
  repos: RepoRecord[];
  tasks: TaskRecord[];
  workspaceRoot: string;
}

const FIXED_TAB_LABELS: Record<(typeof FIXED_CENTER_TAB_IDS)[number], string> = {
  files: "FILES",
  diff: "DIFF",
  logs: "LOGS",
};

const ACTION_FIXTURES: Array<{ id: ActionId; label: string; shortcut: string }> = [
  { id: "commit", label: "commit", shortcut: "c" },
  { id: "push", label: "push", shortcut: "p" },
  { id: "create-pr", label: "create pr", shortcut: "P" },
  { id: "merge", label: "merge", shortcut: "m" },
  { id: "close-task", label: "close task", shortcut: "x" },
];

export function buildShellData(state: ControlShellState, model: WorkspaceShellModel): ShellData {
  const selectedRepo = model.repos.find((repo) => repo.id === state.selectedRepoId) ?? model.repos[0] ?? null;
  const repoTasks = selectedRepo ? model.tasks.filter((task) => task.repoId === selectedRepo.id) : [];
  const selectedTask = repoTasks.find((task) => task.id === state.selectedTaskId) ?? repoTasks[0] ?? null;
  const runnerCounts = countRunners(model.tasks);
  const activeTabId = resolveDisplayActiveTab(state, selectedTask);
  const tabs = buildCenterTabs(state, selectedTask, activeTabId);
  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? tabs[0] ?? { id: "files", label: "FILES" };
  const repoLabel = selectedRepo?.name ?? "no repo";
  const agentLabel = selectedTask?.runner ?? "codex";

  return {
    inputMode: state.inputMode,
    focusedRegion: state.focusedRegion,
    actionMessage: state.actionMessage,
    terminal: state.terminal,
    footerText:
      state.workspaceBrowser !== null
        ? `BROWSE WORKSPACE ${state.workspaceBrowser.cwd}   ↑↓ move   → open   ← up   Enter add repo`
        : state.taskPromptInput !== null
        ? `NEW TASK ${selectedRepo ? `[${selectedRepo.name}]` : "[no repo]"}: ${state.taskPromptInput}${state.taskPromptError ? ` · ${state.taskPromptError}` : ""}`
        : state.inputMode === "terminal"
        ? "TERMINAL   Ctrl+] detach   wheel/PgUp/PgDn scroll"
        : state.focusedRegion === "center"
          ? "NORMAL   + new tab   x close tab   Enter attach   ←/→ switch"
          : "NORMAL   n new task   ? help   / search   : command",
    topRail: {
      workspacePath: path.relative(process.env.HOME ?? "", model.workspaceRoot).length > 0
        ? `~/${path.relative(process.env.HOME ?? "", model.workspaceRoot)}`
        : model.workspaceRoot,
      agent: agentLabel,
      liveLabel: selectedTask?.status === "running" ? "live" : "idle",
    },
    leftTree: buildLeftTree(state, model.repos, model.tasks),
    runners: [
      renderRunnerRow("codex", runnerCounts.codex),
      renderRunnerRow("cursor", runnerCounts.cursor),
    ],
    centerHeader: {
      tabLabel: state.workspaceBrowser ? "BROWSER" : activeTab.label,
      taskId: state.workspaceBrowser ? "new workspace" : selectedTask?.id ?? "no task",
      repo: repoLabel,
      agent: agentLabel,
    },
    centerTranscript: buildCenterTranscript(activeTabId, selectedRepo, selectedTask, state.workspaceBrowser),
    tabs,
    rightContext: buildContextRows(selectedRepo, selectedTask),
    rightChecks: buildCheckRows(selectedTask),
    rightActions: ACTION_FIXTURES.map((action) => ({
      ...action,
      selected: action.id === state.selectedActionId,
      focused: state.focusedRegion === "actions" && action.id === state.selectedActionId,
    })),
    rightNextAction: selectedTask
      ? state.workspaceBrowser
        ? "Press Enter on a [git repo] entry to register it as a Craig workspace."
        : "Use Enter on a PTY tab to attach it. Use + and x from the center strip to manage tabs."
      : selectedRepo
        ? state.workspaceBrowser
          ? "Press Enter on a [git repo] entry to register it as a Craig workspace."
          : "Press n to create a task in the selected repo."
        : state.workspaceBrowser
          ? "Press Enter on a [git repo] entry to register it as a Craig workspace."
          : "Register a repo with `craig repo add <path>` to begin.",
  };
}

function buildLeftTree(state: ControlShellState, repos: RepoRecord[], tasks: TaskRecord[]): ShellTreeRow[] {
  const rows: ShellTreeRow[] = [{ text: "WORKSPACES", muted: true, focused: state.focusedRegion === "tasks" }];

  if (repos.length === 0) {
    rows.push({ text: "No repos registered.", indent: 2, muted: true });
  } else {
    for (const repo of repos) {
      const repoSelected = state.selectedLeftItemId === `repo:${repo.id}`;
      rows.push({
        id: `repo:${repo.id}`,
        text: `▾ ${repo.name}`,
        selected: repoSelected,
        focused: repoSelected && state.focusedRegion === "tasks",
      });
      const repoTasks = tasks.filter((task) => task.repoId === repo.id);

      if (repoTasks.length === 0) {
        rows.push({ text: "└ no tasks yet", indent: 2, muted: true });
        continue;
      }

      for (const [index, task] of repoTasks.entries()) {
        const selected = state.selectedLeftItemId === `task:${task.id}`;
        const prefix = selected ? "▸" : index === repoTasks.length - 1 ? "└" : "•";
        const row: ShellTreeRow = {
          id: `task:${task.id}`,
          taskId: task.id,
          text: `${prefix} ${task.id}`,
          indent: 2,
          selected,
          focused: selected && state.focusedRegion === "tasks",
          accentDot: task.status === "running",
        };
        if (selected) {
          row.status = task.status;
        }
        rows.push(row);
      }
    }
  }

  const newWorkspaceSelected = state.selectedLeftItemId === "new-workspace";
  const newTaskSelected = state.selectedLeftItemId === "new-task";
  rows.push({ text: "", muted: true });
  rows.push({
    id: "new-task",
    text: "+ New Task",
    selected: newTaskSelected,
    focused: newTaskSelected && state.focusedRegion === "tasks",
  });
  rows.push({
    id: "new-workspace",
    text: "+ New Workspace",
    selected: newWorkspaceSelected,
    focused: newWorkspaceSelected && state.focusedRegion === "tasks",
  });

  return rows;
}

function buildCenterTranscript(
  tabId: CenterTabId,
  repo: RepoRecord | null,
  task: TaskRecord | null,
  browser: WorkspaceBrowserState | null,
): string[] {
  if (browser) {
    const entryLines =
      browser.entries.length === 0
        ? ["No directories or git repos here."]
        : browser.entries.map((entry, index) => {
            const marker = index === browser.selectedIndex ? "▸" : " ";
            const suffix = entry.kind === "repo" ? " [git repo]" : "/";
            return `${marker} ${entry.name}${suffix}`;
          });

    return [
      "Browse for a workspace to register.",
      browser.cwd,
      "",
      ...entryLines,
      "",
      browser.error ?? "Use ↑↓ to move, → or Enter to open, ← to go up, Enter on a git repo to add it.",
    ];
  }

  if (!repo) {
    return [
      "No repos registered yet.",
      "",
      "Run `craig repo add <path>` in command mode, then reopen the shell.",
    ];
  }

  if (!task) {
    return [
      `Repo ${repo.name} is ready.`,
      "",
      "Press n to create a task and boot a Codex agent tab in its worktree.",
    ];
  }

  const ptyTab = task.ptyTabs.find((tab) => tab.id === tabId) ?? null;
  if (ptyTab) {
    return ptyTab.kind === "agent"
      ? [
          `${ptyTab.title} tab ready for ${task.id}.`,
          "",
          "Press Enter to attach this PTY-backed agent session.",
          "Use + to create another task tab or x to close this tab.",
        ]
      : [
          `${ptyTab.title} tab ready for ${task.id}.`,
          "",
          "Press Enter to attach this plain task shell.",
          "Use + to create another task tab or x to close this tab.",
        ];
  }

  const fixedTabId = isFixedCenterTabId(tabId) ? tabId : "files";
  const labels: Record<(typeof FIXED_CENTER_TAB_IDS)[number], string> = {
    files: "Files surface",
    diff: "Diff surface",
    logs: "Task logs",
  };

  return [
    `${labels[fixedTabId]} placeholder for ${task.id}.`,
    "",
    "Real inspection surfaces land in later RFC phases.",
  ];
}

function buildCenterTabs(state: ControlShellState, task: TaskRecord | null, activeTabId: string): ShellTab[] {
  const ptyTabs =
    task?.ptyTabs.map((tab) => ({
      id: tab.id,
      label: formatPtyTabLabel(tab),
    })) ?? [];
  const fixedTabs = FIXED_CENTER_TAB_IDS.map((id) => ({
    id,
    label: FIXED_TAB_LABELS[id],
  }));

  return [...ptyTabs, ...fixedTabs].map((tab) => ({
    ...tab,
    active: tab.id === activeTabId,
    focused: state.focusedRegion === "center" && tab.id === activeTabId,
  }));
}

function resolveDisplayActiveTab(state: ControlShellState, task: TaskRecord | null): string {
  if (!task) {
    return isFixedCenterTabId(state.activeTab) ? state.activeTab : "files";
  }

  if (task.ptyTabs.some((tab) => tab.id === state.activeTab) || isFixedCenterTabId(state.activeTab)) {
    return state.activeTab;
  }

  if (state.activeTab === "agent" || state.activeTab === "terminal") {
    return task.ptyTabs.find((tab) => tab.kind === state.activeTab)?.id ?? task.ptyTabs[0]?.id ?? "files";
  }

  return state.selectedPtyTabId && task.ptyTabs.some((tab) => tab.id === state.selectedPtyTabId)
    ? state.selectedPtyTabId
    : task.ptyTabs[0]?.id ?? "files";
}

function formatPtyTabLabel(tab: TaskPtyTabRecord): string {
  return tab.title.toUpperCase();
}

function isFixedCenterTabId(tabId: string): tabId is (typeof FIXED_CENTER_TAB_IDS)[number] {
  return (FIXED_CENTER_TAB_IDS as readonly string[]).includes(tabId);
}

function buildContextRows(repo: RepoRecord | null, task: TaskRecord | null): ShellContextRow[] {
  if (!repo) {
    return [{ label: "Repo", value: "none", mutedValue: true }];
  }

  if (!task) {
    return [
      { label: "Repo", value: repo.name },
      { label: "Branch", value: repo.defaultBranch },
      { label: "Task", value: "none", mutedValue: true },
    ];
  }

  return [
    { label: "Task", value: task.id },
    { label: "Repo", value: repo.name },
    { label: "Agent", value: task.runner },
    { label: "Branch", value: task.branch },
    { label: "Status", value: task.status },
    { label: "Worktree", value: path.basename(task.worktreePath) },
  ];
}

function buildCheckRows(task: TaskRecord | null): ShellCheckRow[] {
  if (!task) {
    return [{ status: "○", label: "Checks", result: "n/a", duration: "--" }];
  }

  return [
    {
      status: task.checks.status === "passed" ? "✓" : "○",
      label: "Checks",
      result: task.checks.status,
      duration: task.checks.lastRunAt ? "done" : "--",
      success: task.checks.status === "passed",
    },
    {
      status: task.runnerSession.lastKnownState === "running" ? "✓" : "○",
      label: "Runner",
      result: task.runnerSession.lastKnownState,
      duration: task.runnerSession.startedAt ? "live" : "--",
      success: task.runnerSession.lastKnownState === "running",
    },
  ];
}

function countRunners(tasks: TaskRecord[]): Record<"codex" | "cursor", number> {
  return tasks.reduce(
    (counts, task) => {
      counts[task.runner] += 1;
      return counts;
    },
    { codex: 0, cursor: 0 },
  );
}

function renderRunnerRow(name: "codex" | "cursor", count: number): ShellRunnerRow {
  const bounded = Math.max(0, Math.min(10, count));
  return {
    name,
    meter: `[${"#".repeat(bounded).padEnd(10, ".")}]`,
    count: String(count),
  };
}
