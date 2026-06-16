import path from "node:path";

import type { InspectionDiffGroup, InspectionDiffRow, TaskLocalInspection } from "../services/task-local-inspection.js";
import {
  CHECK_ICON_FAILED,
  CHECK_ICON_NONE,
  CHECK_ICON_PENDING,
  CHECK_ICON_SUCCESS,
  DIR_ICON_CLOSED,
  DIR_ICON_OPEN,
  PR_ICON_CLOSED,
  PR_ICON_MERGED,
  PR_ICON_NONE,
  PR_ICON_OPEN,
  getFileIcon,
  getFileIconColor,
} from "./icons.js";
import type { ProjectTaskRepoTarget, RunnerType, TaskPullRequest, TaskPullRequestCheck, TaskPullRequestComment, TaskPtyTabRecord, TaskRecord } from "../types/task.js";
import { getTaskPrimaryPr } from "../services/github-pr.js";
import type { RepoRecord, WorkspaceRecord } from "../types/workspace.js";
import { getRunnerDisplayName } from "../services/runner-profiles.js";
import { INSPECTION_TAB_ID, isTaskLeftItemId } from "./state.js";
import type { TerminalCellStyle, TerminalRowSegment } from "./terminal-emulator.js";
import type {
  CenterTabId,
  ControlShellState,
  FooterToast,
  FocusRegion,
  InputMode,
  TerminalViewState,
  WorkspaceBrowserState,
} from "./state.js";

const EMPTY_CENTER_TAB_ID = "empty";

export interface ShellTopRail {
  workspacePath: string;
  agent: string;
}

export interface ShellTreeRow {
  id?: string;
  text: string;
  taskId?: string;
  indent?: number;
  selected?: boolean;
  focused?: boolean;
  accentDot?: boolean;
  panelHeader?: boolean;
  status?: string;
  muted?: boolean;
  prBadge?: TerminalRowSegment[];
}

export interface ShellRunnerRow {
  name: string;
  health: number;
  unlimited?: boolean;
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

export interface ShellInspectionRow {
  id: string;
  text: string;
  selected?: boolean;
  focused?: boolean;
  muted?: boolean;
  accentPrefix?: boolean;
  color?: string;
  segments?: TerminalRowSegment[];
}

export interface ShellInspectionSection {
  title: string;
  rows: ShellInspectionRow[];
}

export interface ShellCenterLine {
  text: string;
  segments?: TerminalRowSegment[];
  tone?: "default" | "muted" | "selected" | "focused";
  fullBleed?: boolean;
}

export interface ShellData {
  inputMode: InputMode;
  modalInput: boolean;
  focusedRegion: FocusRegion;
  actionMessage: string | null;
  footerToast: FooterToast | null;
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
  centerTranscript: ShellCenterLine[];
  tabs: ShellTab[];
  rightContext: ShellContextRow[];
  rightInspection: ShellInspectionSection | null;
}

export interface WorkspaceShellModel {
  workspaces?: WorkspaceRecord[];
  repos: RepoRecord[];
  tasks: TaskRecord[];
  workspaceRoot: string;
  inspection: TaskLocalInspection | null;
  enabledRunnerIds?: RunnerType[];
}

export interface DiffPathRange {
  path: string;
  start: number;
  end: number;
}

const SYNTAX_COLORS = {
  lineNumber: "3b4261",
  gutter:     "3b4261",
  keyword:    "9d7cd8",
  string:     "9ece6a",
  literal:    "ff9e64",
  comment:    "565f89",
  markup:     "f7768e",
  diffAdd:    "9ece6a",
  diffDelete: "f7768e",
  diffMeta:   "565f89",
  diffHunk:   "565f89",
} as const;

export function buildShellData(state: ControlShellState, model: WorkspaceShellModel): ShellData {
  const selectedWorkspace = resolveSelectedWorkspace(model, state);
  const selectedRepo = model.repos.find((repo) => repo.id === state.selectedRepoId) ?? model.repos[0] ?? null;
  const workspaceTasks = selectedWorkspace ? model.tasks.filter((task) => task.workspaceId === selectedWorkspace.id) : model.tasks;
  const repoTasks = selectedWorkspace?.kind === "project"
    ? workspaceTasks
    : selectedRepo
      ? workspaceTasks.filter((task) => task.repoId === selectedRepo.id)
      : [];
  const selectedTask = repoTasks.find((task) => task.id === state.selectedTaskId) ?? repoTasks[0] ?? null;
  const isProjectTask = selectedTask?.type === "project";
  const runnerCounts = countRunners(model.tasks);
  const activeTabId = resolveDisplayActiveTab(state, selectedTask);
  const tabs = buildCenterTabs(state, selectedTask, activeTabId);
  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? tabs[0] ?? { id: "agent", label: "CODEX" };
  const selectedInspection = model.inspection?.taskId === selectedTask?.id ? model.inspection : null;
  const repoLabel = selectedRepo?.name ?? "no repo";
  const agentLabel = selectedTask ? getRunnerDisplayName(selectedTask.runner) : getRunnerDisplayName(state.selectedRunner);

  return {
    inputMode: state.inputMode,
    modalInput: state.taskPromptInput !== null || state.workspaceBrowser !== null,
    focusedRegion: state.focusedRegion,
    actionMessage: state.actionMessage,
    footerToast: state.footerToast,
    terminal: state.terminal,
    footerText:
      state.workspaceBrowser !== null
        ? `BROWSE WORKSPACE ${state.workspaceBrowser.cwd}   ↑↓ move   → open   ← up   Enter add repo   Esc cancel`
        : state.taskPromptInput !== null
        ? `NEW TASK ${selectedRepo ? `[${selectedRepo.name}]` : "[no repo]"} · ${getRunnerDisplayName(state.selectedRunner)}   Ctrl+R switch runner   Enter create   Esc cancel   ›   ${state.taskPromptInput}${state.taskPromptError ? `   ✗ ${state.taskPromptError}` : ""}`
        : state.inputMode === "terminal"
        ? "TERMINAL   ↑↓/PgUp/PgDn scroll   Ctrl+] return to control"
        : state.focusedRegion === "tasks"
          ? state.selectedLeftItemId?.startsWith("new-task:")
            || state.selectedLeftItemId?.startsWith("new-task-workspace:")
            ? `r runner [${getRunnerDisplayName(state.selectedRunner)}]   Enter create task   Esc pause   ? help`
            : isTaskLeftItemId(state.selectedLeftItemId)
            ? "n new task   Enter attach   X close task   Esc pause   ? help"
            : state.selectedLeftItemId?.startsWith("workspace:")
            ? "n new task   Enter select   X remove workspace   Esc pause   ? help"
            : "n new task   Enter select   Esc pause   ? help"
        : state.focusedRegion === "center"
          ? selectedTask === null
            ? "n new task   Tab tasks   Esc pause   ? help"
            : activeTabId === INSPECTION_TAB_ID
            ? "↑↓/wheel/PgUp/PgDn scroll   ←/→ switch   Tab inspector   Esc pause   ? help"
            : `+ new tab   a ${getRunnerDisplayName(state.centerTabRunner ?? (selectedTask?.runner ?? state.selectedRunner))}   r runner   t terminal   x close   Enter attach   Esc pause   ? help`
          : state.inspectionMode === "review"
          ? isProjectTask
            ? "↑↓ targets   Wheel/PgUp/PgDn scroll   o open PR   R refresh checks   X close task   ←/→ mode   Esc pause   ? help"
            : "Wheel/PgUp/PgDn scroll   o open PR   R refresh checks   X close task   ←/→ mode   Esc pause   ? help"
          : state.inspectionMode === "files"
          ? "↑↓ navigate   Enter open file   ←/→ mode   Esc pause   ? help"
          : "↑↓ navigate   ←/→ mode   Esc pause   ? help",
    topRail: {
      workspacePath: path.relative(process.env.HOME ?? "", model.workspaceRoot).length > 0
        ? `~/${path.relative(process.env.HOME ?? "", model.workspaceRoot)}`
        : model.workspaceRoot,
      agent: agentLabel,
    },
    leftTree: buildLeftTree(state, model),
    runners: (model.enabledRunnerIds ?? ["codex", "cursor", "claude"]).map((runner) => renderRunnerRow(runner, runnerCounts[runner])),
    centerHeader: {
      tabLabel: state.workspaceBrowser ? "BROWSER" : activeTab.label,
      taskId: state.workspaceBrowser ? "new workspace" : selectedTask?.id ?? "no task",
      repo: repoLabel,
      agent: agentLabel,
    },
    centerTranscript: buildCenterTranscript(activeTabId, state, selectedRepo, selectedTask, state.workspaceBrowser, selectedInspection, selectedWorkspace),
    tabs,
    rightContext: buildContextRows(selectedRepo, selectedTask),
    rightInspection: buildInspectionSection(state, selectedTask, selectedInspection),
  };
}

function buildLeftTree(state: ControlShellState, model: WorkspaceShellModel): ShellTreeRow[] {
  const rows: ShellTreeRow[] = [{ text: "WORKSPACES", muted: true, panelHeader: true, focused: state.focusedRegion === "tasks" }];

  if (!model.workspaces) {
    return buildLegacyRepoLeftTree(rows, state, model.repos, model.tasks);
  }

  const workspaces = model.workspaces;

  if (workspaces.length === 0) {
    rows.push({ text: "No workspaces registered.", indent: 2, muted: true });
  } else {
    for (const workspace of workspaces) {
      const workspaceSelected = state.selectedLeftItemId === `workspace:${workspace.id}`;
      rows.push({
        id: `workspace:${workspace.id}`,
        text: `${workspace.kind === "project" ? "≡" : "–"} ${workspace.name ?? workspace.id}`,
        selected: workspaceSelected,
        focused: workspaceSelected && state.focusedRegion === "tasks",
      });
      const workspaceRepoIds = workspace.kind === "project" ? workspace.discoveredRepoIds ?? [] : [workspace.primaryRepoId];
      const repoTasks = model.tasks.filter((task) => task.workspaceId === workspace.id);

      if (repoTasks.length === 0) {
        rows.push({ text: "  · no tasks yet", indent: 0, muted: true });
      } else {
        for (const task of repoTasks) {
          const selected = state.selectedLeftItemId === `task:${task.id}`;
          const prefix = selected ? "▸" : "•";
          const displayTitle = task.title.length > 28 ? `${task.title.slice(0, 25)}…` : task.title;
          const row: ShellTreeRow = {
            id: `task:${task.id}`,
            taskId: task.id,
            text: `${prefix} ${displayTitle}`,
            indent: 2,
            selected,
            focused: selected && state.focusedRegion === "tasks",
          };
          const prBadge = buildTaskPrBadgeSegments(task);
          if (prBadge) {
            row.prBadge = prBadge;
          }
          rows.push(row);
        }
      }

      if (workspace.kind === "project") {
        const newTaskId = `new-task-workspace:${workspace.id}`;
        const newTaskSelected = state.selectedLeftItemId === newTaskId;
        rows.push({
          id: newTaskId,
          text: `+ New Project Task [${getRunnerDisplayName(state.selectedRunner)}]`,
          indent: 2,
          selected: newTaskSelected,
          focused: newTaskSelected && state.focusedRegion === "tasks",
          muted: !newTaskSelected,
        });
      }

      if (workspace.kind === "repo") {
        const newTaskId = `new-task:${workspace.primaryRepoId}`;
        const newTaskSelected = state.selectedLeftItemId === newTaskId;
        rows.push({
          id: newTaskId,
          text: `+ New Task [${getRunnerDisplayName(state.selectedRunner)}]`,
          indent: 2,
          selected: newTaskSelected,
          focused: newTaskSelected && state.focusedRegion === "tasks",
          muted: !newTaskSelected,
        });
      } else {
        rows.push({ text: `  Repos (${workspaceRepoIds.length})`, indent: 0, muted: true });
        for (const repoId of workspaceRepoIds.slice(0, 6)) {
          const repo = model.repos.find((entry) => entry.id === repoId);
          rows.push({ text: `  · ${repo?.name ?? repoId}`, indent: 0, muted: true });
        }
        if (workspaceRepoIds.length > 6) {
          rows.push({ text: `  · ${workspaceRepoIds.length - 6} more`, indent: 0, muted: true });
        }
      }
    }
  }

  const newWorkspaceSelected = state.selectedLeftItemId === "new-workspace";
  rows.push({ text: "", muted: true });
  rows.push({
    id: "new-workspace",
    text: "+ New Workspace",
    selected: newWorkspaceSelected,
    focused: newWorkspaceSelected && state.focusedRegion === "tasks",
  });

  return rows;
}

function buildLegacyRepoLeftTree(rows: ShellTreeRow[], state: ControlShellState, repos: RepoRecord[], tasks: TaskRecord[]): ShellTreeRow[] {
  if (repos.length === 0) {
    rows.push({ text: "No repos registered.", indent: 2, muted: true });
  } else {
    for (const repo of repos) {
      const repoSelected = state.selectedLeftItemId === `repo:${repo.id}`;
      rows.push({
        id: `repo:${repo.id}`,
        text: `– ${repo.name}`,
        selected: repoSelected,
        focused: repoSelected && state.focusedRegion === "tasks",
      });
      const repoTasks = tasks.filter((task) => task.repoId === repo.id);

      if (repoTasks.length === 0) {
        rows.push({ text: "  · no tasks yet", indent: 0, muted: true });
      } else {
        for (const task of repoTasks) {
          const selected = state.selectedLeftItemId === `task:${task.id}`;
          const prefix = selected ? "▸" : "•";
          const displayTitle = task.title.length > 28 ? `${task.title.slice(0, 25)}…` : task.title;
          const legacyRow: ShellTreeRow = {
            id: `task:${task.id}`,
            taskId: task.id,
            text: `${prefix} ${displayTitle}`,
            indent: 2,
            selected,
            focused: selected && state.focusedRegion === "tasks",
          };
          const prBadge = buildTaskPrBadgeSegments(task);
          if (prBadge) {
            legacyRow.prBadge = prBadge;
          }
          rows.push(legacyRow);
        }
      }

      const newTaskId = `new-task:${repo.id}`;
      const newTaskSelected = state.selectedLeftItemId === newTaskId;
      rows.push({
        id: newTaskId,
        text: `+ New Task [${getRunnerDisplayName(state.selectedRunner)}]`,
        indent: 2,
        selected: newTaskSelected,
        focused: newTaskSelected && state.focusedRegion === "tasks",
        muted: !newTaskSelected,
      });
    }
  }

  const newWorkspaceSelected = state.selectedLeftItemId === "new-workspace";
  rows.push({ text: "", muted: true });
  rows.push({
    id: "new-workspace",
    text: "+ New Workspace",
    selected: newWorkspaceSelected,
    focused: newWorkspaceSelected && state.focusedRegion === "tasks",
  });
  return rows;
}

function resolveSelectedWorkspace(model: WorkspaceShellModel, state: ControlShellState): WorkspaceRecord | null {
  const workspaces = model.workspaces ?? [];
  if (!model.workspaces) {
    return null;
  }
  const selectedTask = model.tasks.find((task) => task.id === state.selectedTaskId) ?? null;
  if (selectedTask) {
    return workspaces.find((workspace) => workspace.id === selectedTask.workspaceId) ?? null;
  }
  if (state.selectedWorkspaceId) {
    return workspaces.find((workspace) => workspace.id === state.selectedWorkspaceId) ?? null;
  }
  return workspaces[0] ?? null;
}

function buildCenterTranscript(
  tabId: CenterTabId,
  state: ControlShellState,
  repo: RepoRecord | null,
  task: TaskRecord | null,
  browser: WorkspaceBrowserState | null,
  inspection: TaskLocalInspection | null = null,
  workspace: WorkspaceRecord | null = null,
): ShellCenterLine[] {
  if (browser) {
    const entryLines =
      browser.entries.length === 0
        ? ["No directories or git repos here."]
        : browser.entries.map((entry, index) => {
            const marker = index === browser.selectedIndex ? "▸" : " ";
            const suffix = entry.kind === "repo" ? " [git repo]" : "/";
            return `${marker} ${entry.name}${suffix}`;
          });

    return textLines([
      "Browse for a workspace to register.",
      browser.cwd,
      "",
      ...entryLines,
      "",
      browser.error ?? "Use ↑↓ to move, → or Enter to open, ← to go up, Enter on a git repo to add it.",
    ]);
  }

  if (!repo) {
    return textLines([
      "No repos registered yet.",
      "",
      "Run `craig repo add <path>` in command mode, then reopen the shell.",
    ]);
  }

  if (!task) {
    const isProjectWorkspace = workspace?.kind === "project";
    const contextLabel = isProjectWorkspace ? (workspace.name ?? "this workspace") : repo.name;
    const taskKind = isProjectWorkspace ? "Project Task" : "Task";
    return textLines([
      `No tasks in ${contextLabel}.`,
      "",
      `Press n or choose + New ${taskKind} to create one with ${getRunnerDisplayName(state.selectedRunner)}.`,
    ]);
  }

  const ptyTab = task.ptyTabs.find((tab) => tab.id === tabId) ?? null;
  if (ptyTab) {
    return ptyTab.kind === "agent"
      ? textLines([
          `${ptyTab.title} tab ready for ${task.id}.`,
          "",
          "Press Enter to attach this PTY-backed agent session.",
          "Use + to create another task tab, a/t for a specific kind, or x to close this tab.",
        ])
      : textLines([
          `${ptyTab.title} tab ready for ${task.id}.`,
          "",
          "Press Enter to attach this plain task shell.",
          "Use + to create another task tab, a/t for a specific kind, or x to close this tab.",
        ]);
  }

  if (tabId === INSPECTION_TAB_ID && state.openInspectionKind === "file") {
    return buildFileTranscript(task, inspection, state.fileScrollOffset);
  }

  if (tabId === INSPECTION_TAB_ID && state.openInspectionKind === "diff") {
    return buildDiffTranscript(task, inspection, state.diffScrollOffset);
  }

  if (task.ptyTabs.length === 0 && !state.openInspectionKind) {
    return textLines([
      "No task tabs open.",
      "",
      "Press a to create an agent tab, t to create a Terminal tab, or + to create the preferred tab kind.",
    ]);
  }

  return textLines(["No center tab selected.", "", "Choose a task PTY tab or open an inspection item from the right panel."]);
}

function buildCenterTabs(state: ControlShellState, task: TaskRecord | null, activeTabId: string): ShellTab[] {
  const ptyTabs =
    task?.ptyTabs.map((tab) => ({
      id: tab.id,
      label: formatPtyTabLabel(tab),
    })) ?? [];

  if (!task) {
    return [{
      id: EMPTY_CENTER_TAB_ID,
      label: "EMPTY",
      active: activeTabId === EMPTY_CENTER_TAB_ID,
      focused: state.focusedRegion === "center" && activeTabId === EMPTY_CENTER_TAB_ID,
    }];
  }

  const inspectionTab = state.openInspectionKind || activeTabId === INSPECTION_TAB_ID
    ? [{
        id: INSPECTION_TAB_ID,
        label: formatInspectionTabLabel(state),
      }]
    : [];

  return [...ptyTabs, ...inspectionTab].map((tab) => ({
    ...tab,
    active: tab.id === activeTabId,
    focused: state.focusedRegion === "center" && tab.id === activeTabId,
  }));
}

function resolveDisplayActiveTab(state: ControlShellState, task: TaskRecord | null): string {
  if (!task) {
    return EMPTY_CENTER_TAB_ID;
  }

  if (
    task.ptyTabs.some((tab) => tab.id === state.activeTab) ||
    (state.activeTab === INSPECTION_TAB_ID && state.openInspectionKind)
  ) {
    return state.activeTab;
  }

  if (state.activeTab === "agent" || state.activeTab === "terminal") {
    return task.ptyTabs.find((tab) => tab.kind === state.activeTab)?.id ?? task.ptyTabs[0]?.id ?? INSPECTION_TAB_ID;
  }

  return state.selectedPtyTabId && task.ptyTabs.some((tab) => tab.id === state.selectedPtyTabId)
    ? state.selectedPtyTabId
    : task.ptyTabs[0]?.id ?? INSPECTION_TAB_ID;
}

function formatPtyTabLabel(tab: TaskPtyTabRecord): string {
  return tab.title.toUpperCase();
}

function formatInspectionTabLabel(state: ControlShellState): string {
  const selectedPath = state.openInspectionKind === "diff" ? state.selectedDiffPath : state.selectedFilePath;
  const base = selectedPath ? path.basename(selectedPath) : state.inspectionMode.toUpperCase();
  return state.openInspectionKind === "diff" ? `${base} Δ` : base;
}

function buildFileTranscript(task: TaskRecord | null, inspection: TaskLocalInspection | null, scrollOffset: number): ShellCenterLine[] {
  if (!task) {
    return textLines(["No task selected.", "", "Select or create a task to inspect files."]);
  }

  if (!inspection || inspection.error) {
    return textLines(["Files unavailable.", "", inspection?.error ?? "Craig has not loaded file inspection for this task yet."]);
  }

  const content = inspection.selectedFile;
  const language = detectLanguage(content.path ?? content.title);
  return [
    { text: content.title },
    { text: `${content.byteLength === null ? "size unknown" : `${content.byteLength} bytes`} · ${content.lines.length} lines · PgUp/PgDn or wheel scroll`, tone: "muted" },
    { text: "" },
    ...renderNumberedContentLines(content.lines, scrollOffset, language),
  ];
}

function buildDiffTranscript(task: TaskRecord | null, inspection: TaskLocalInspection | null, scrollOffset: number): ShellCenterLine[] {
  if (!task) {
    return textLines(["No task selected.", "", "Select or create a task to inspect diffs."]);
  }

  if (!inspection || inspection.error) {
    return textLines(["Diff unavailable.", "", inspection?.error ?? "Craig has not loaded diff inspection for this task yet."]);
  }

  const content = inspection.selectedDiff;
  const language = detectLanguage(content.path ?? content.title);
  return [
    { text: content.title },
    {
      text: `${inspection.diffPaths.length} changed files · ${content.lines.length} rows · PgUp/PgDn or wheel scroll`,
      tone: "muted",
    },
    { text: "" },
    ...renderUnifiedDiffLines(content.lines, scrollOffset, language),
  ];
}

export function getCombinedDiffPathRanges(inspection: TaskLocalInspection | null): DiffPathRange[] {
  if (!inspection) {
    return [];
  }

  let offset = 0;
  return inspection.diffPaths.map((diffPath) => {
    const content = inspection.diffContents[diffPath] ?? inspection.selectedDiff;
    const lineCount = 1 + content.lines.length + 1;
    const range = { path: diffPath, start: offset, end: offset + lineCount };
    offset += lineCount;
    return range;
  });
}

export function getCombinedDiffLineCount(inspection: TaskLocalInspection | null): number {
  return getCombinedDiffPathRanges(inspection).at(-1)?.end ?? 0;
}

function textLines(lines: string[]): ShellCenterLine[] {
  return lines.map((line) => ({ text: line }));
}

function renderNumberedContentLines(lines: string[], scrollOffset: number, language: string): ShellCenterLine[] {
  const lineNumberWidth = Math.max(3, String(lines.length).length);
  const start = Math.max(0, Math.min(scrollOffset, Math.max(0, lines.length - 1)));
  return lines.slice(start).map((line, index) => {
    const lineNumber = start + index + 1;
    const prefix = `${String(lineNumber).padStart(lineNumberWidth, " ")} │ `;
    return {
      text: `${prefix}${line}`,
      segments: [
        { text: String(lineNumber).padStart(lineNumberWidth, " "), style: { fg: SYNTAX_COLORS.lineNumber } },
        { text: " │ ", style: { fg: SYNTAX_COLORS.gutter } },
        ...highlightContentLine(line, language),
      ],
      tone: "default" as const,
    };
  });
}

function renderUnifiedDiffLines(lines: string[], scrollOffset: number, language: string): ShellCenterLine[] {
  const rows = parseUnifiedDiff(lines);
  const start = Math.max(0, Math.min(scrollOffset, Math.max(0, rows.length - 1)));
  return rows.slice(start).map((row) => renderUnifiedDiffRow(row, language));
}

interface UnifiedDiffRow {
  oldNumber: number | null;
  newNumber: number | null;
  marker: " " | "+" | "-" | "";
  text: string;
  kind: "context" | "add" | "delete";
}

function parseUnifiedDiff(lines: string[]): UnifiedDiffRow[] {
  const rows: UnifiedDiffRow[] = [];
  let oldLine = 0;
  let newLine = 0;

  for (const line of lines) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      oldLine = Number.parseInt(hunk[1] ?? "0", 10);
      newLine = Number.parseInt(hunk[2] ?? "0", 10);
      continue;
    }

    if (line.startsWith("diff --git") || line.startsWith("index ") || line.startsWith("+++ ") || line.startsWith("--- ")) {
      continue;
    }

    if (line === "staged" || line === "unstaged" || line === "untracked") {
      continue;
    }

    if (line.startsWith("-") && !line.startsWith("---")) {
      rows.push({
        oldNumber: oldLine,
        newNumber: null,
        marker: "-",
        text: line.slice(1),
        kind: "delete",
      });
      oldLine += 1;
      continue;
    }

    if (line.startsWith("+") && !line.startsWith("+++")) {
      rows.push({
        oldNumber: null,
        newNumber: newLine,
        marker: "+",
        text: line.slice(1),
        kind: "add",
      });
      newLine += 1;
      continue;
    }

    if (line.startsWith(" ")) {
      if (oldLine === 0 && newLine === 0) {
        continue;
      }

      rows.push({
        oldNumber: oldLine,
        newNumber: newLine,
        marker: " ",
        text: line.slice(1),
        kind: "context",
      });
      oldLine += 1;
      newLine += 1;
      continue;
    }

  }

  return rows;
}

function renderUnifiedDiffRow(row: UnifiedDiffRow, language: string): ShellCenterLine {
  const oldNumber = formatDiffLineNumber(row.oldNumber);
  const newNumber = formatDiffLineNumber(row.newNumber);
  const visibleNumber = row.kind === "delete" ? oldNumber : newNumber;
  const overlay = row.kind === "delete"
    ? { bg: "2a1111", fallbackFg: SYNTAX_COLORS.diffDelete }
    : row.kind === "add"
      ? { bg: "10210f", fallbackFg: SYNTAX_COLORS.diffAdd }
      : null;
  const text = `${visibleNumber} │ ${row.text}`;
  const contentSegments = overlay
    ? addOverlayToSegments(highlightContentLine(row.text, language), overlay.bg, overlay.fallbackFg)
    : highlightContentLine(row.text, language);
  const gutterStyle = overlay ? { fg: SYNTAX_COLORS.lineNumber, bg: overlay.bg } : { fg: SYNTAX_COLORS.lineNumber };
  const dividerStyle = overlay ? { fg: SYNTAX_COLORS.gutter, bg: overlay.bg } : { fg: SYNTAX_COLORS.gutter };
  return {
    text,
    segments: [
      { text: visibleNumber, style: gutterStyle },
      { text: " │ ", style: dividerStyle },
      ...contentSegments,
    ],
    fullBleed: overlay !== null,
  };
}

function formatDiffLineNumber(value: number | null): string {
  return value === null ? "    " : String(value).padStart(4, " ");
}

function detectLanguage(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  if ([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(extension)) {
    return "javascript";
  }
  if ([".json", ".jsonc"].includes(extension)) {
    return "json";
  }
  if ([".md", ".mdx"].includes(extension)) {
    return "markdown";
  }
  if ([".css", ".scss"].includes(extension)) {
    return "css";
  }
  return "plain";
}

function highlightContentLine(line: string, language: string): TerminalRowSegment[] {
  if (language === "diff") {
    return highlightDiffLine(line);
  }
  if (language === "markdown") {
    return highlightMarkdownLine(line);
  }
  if (language === "json") {
    return highlightPatternLine(line, /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|-?\b\d+(?:\.\d+)?\b/g);
  }
  if (language === "javascript" || language === "css") {
    return highlightPatternLine(
      line,
      /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|\/\/.*$|\/\*.*?\*\/|\b(const|let|var|function|return|if|else|for|while|class|interface|type|import|export|from|async|await|new|extends|implements|switch|case|break|continue|try|catch|throw|true|false|null|undefined)\b|-?\b\d+(?:\.\d+)?\b/g,
    );
  }

  return [{ text: line }];
}

function highlightDiffLine(line: string): TerminalRowSegment[] {
  if (line.startsWith("+") && !line.startsWith("+++")) {
    return [{ text: line, style: { fg: SYNTAX_COLORS.diffAdd } }];
  }
  if (line.startsWith("-") && !line.startsWith("---")) {
    return [{ text: line, style: { fg: SYNTAX_COLORS.diffDelete } }];
  }
  if (line.startsWith("@@")) {
    return [{ text: line, style: { fg: SYNTAX_COLORS.diffHunk } }];
  }
  if (line.startsWith("diff --git") || line.startsWith("index ") || line.startsWith("+++ ") || line.startsWith("--- ")) {
    return [{ text: line, style: { fg: SYNTAX_COLORS.diffMeta } }];
  }
  return [{ text: line }];
}

function addOverlayToSegments(segments: TerminalRowSegment[], bg: string, fallbackFg: string): TerminalRowSegment[] {
  return segments.map((segment) => ({
    text: segment.text,
    style: {
      ...(segment.style ?? { fg: fallbackFg }),
      bg,
    },
  }));
}

function highlightMarkdownLine(line: string): TerminalRowSegment[] {
  if (/^#{1,6}\s/.test(line)) {
    return [{ text: line, style: { fg: SYNTAX_COLORS.markup, bold: true } }];
  }
  return highlightPatternLine(line, /(`[^`]+`)|(\*\*[^*]+\*\*)|(\[[^\]]+\]\([^)]+\))/g);
}

function highlightPatternLine(line: string, pattern: RegExp): TerminalRowSegment[] {
  const segments: TerminalRowSegment[] = [];
  let cursor = 0;

  for (const match of line.matchAll(pattern)) {
    const value = match[0];
    const index = match.index ?? 0;
    if (index > cursor) {
      segments.push({ text: line.slice(cursor, index) });
    }
    segments.push({ text: value, style: styleForToken(value) });
    cursor = index + value.length;
  }

  if (cursor < line.length) {
    segments.push({ text: line.slice(cursor) });
  }

  return segments.length > 0 ? segments : [{ text: line }];
}

function styleForToken(token: string): TerminalCellStyle {
  if (token.startsWith("//") || token.startsWith("/*")) {
    return { fg: SYNTAX_COLORS.comment, italic: true };
  }
  if (token.startsWith("\"") || token.startsWith("'") || token.startsWith("`")) {
    return { fg: SYNTAX_COLORS.string };
  }
  if (/^-?\d/.test(token) || token === "true" || token === "false" || token === "null" || token === "undefined") {
    return { fg: SYNTAX_COLORS.literal };
  }
  if (token.startsWith("**") || token.startsWith("[") || token.startsWith("`")) {
    return { fg: SYNTAX_COLORS.markup };
  }
  return { fg: SYNTAX_COLORS.keyword };
}

function buildInspectionSection(
  state: ControlShellState,
  task: TaskRecord | null,
  inspection: TaskLocalInspection | null,
): ShellInspectionSection | null {
  const effectiveTargetId = state.selectedProjectTargetId ?? task?.repoTargets?.[0]?.repoId ?? null;
  const selectedTarget = task?.type === "project" && effectiveTargetId
    ? task.repoTargets?.find((t) => t.repoId === effectiveTargetId) ?? null
    : null;
  const effectivePr = task?.type === "project"
    ? buildAggregateProjectPullRequest(task.repoTargets ?? [])
    : selectedTarget?.pullRequest ?? (task ? getTaskPrimaryPr(task) : null);
  const modeRows = [renderInspectionModeRow(state, effectivePr), { id: "mode-spacer", text: "", muted: true }];
  if (state.inspectionMode === "review") {
    return {
      title: "",
      rows: [...modeRows, ...buildReviewInspectionRows(state, task)],
    };
  }

  if (state.inspectionMode === "files") {
    return {
      title: "",
      rows: [...modeRows, ...buildFileInspectionRows(state, inspection)],
    };
  }

  return {
    title: "",
    rows: [...modeRows, ...buildDiffInspectionRows(state, inspection)],
  };
}

function renderInspectionModeRow(state: ControlShellState, pr: PrBadgeDetail | null): ShellInspectionRow {
  const mode = state.inspectionMode;
  const modes = [
    { label: "CHANGES", active: mode === "diff" },
    { label: "FILES", active: mode === "files" },
    { label: "REVIEW", active: mode === "review" },
  ];
  const segments: TerminalRowSegment[] = [];
  for (let i = 0; i < modes.length; i++) {
    const m = modes[i]!;
    if (i > 0) segments.push({ text: "  " });
    const activeFg = m.active
      ? (state.focusedRegion === "inspector" || state.focusedRegion === "actions" ? "9ece6a" : "7aa2f7")
      : "565f89";
    segments.push({ text: m.label, style: { fg: activeFg } });
  }

  const prSegment = buildPrLifecycleSegment(pr);
  const checksSegment = buildPrReadinessSegment(pr);
  segments.push({ text: "  " }, prSegment, { text: " " }, checksSegment);

  const text = segments.map((s) => s.text).join("");
  return { id: "inspection-mode", text, segments };
}

interface PrBadgeDetail {
  number: number | null;
  status: string | null;
  draft?: boolean;
  mergeable?: boolean;
  mergeStateStatus?: string | null;
  reviewDecision?: TaskPullRequest["reviewDecision"];
  requiredChecks: TaskPullRequestCheck[];
  aggregateReadiness?: PrReadinessStatus;
}

type PrReadinessStatus = "none" | "pending" | "success" | "failed";

function buildPrBadgeSegments(pr: PrBadgeDetail): TerminalRowSegment[] {
  return [
    { text: " " },
    buildPrLifecycleSegment(pr),
    { text: " " },
    buildPrReadinessSegment(pr),
  ];
}

function buildTaskPrBadgeSegments(task: TaskRecord): TerminalRowSegment[] | null {
  if (task.type === "project" && task.repoTargets?.length) {
    const aggregatePr = buildAggregateProjectPullRequest(task.repoTargets);
    return aggregatePr ? buildPrBadgeSegments(aggregatePr) : null;
  }

  const primaryPr = getTaskPrimaryPr(task);
  return primaryPr?.number ? buildPrBadgeSegments(primaryPr) : null;
}

function buildAggregateProjectPullRequest(targets: ProjectTaskRepoTarget[]): PrBadgeDetail | null {
  const readyTargets = targets.filter((target) => target.status === "ready");
  const prs = readyTargets.map((target) => target.pullRequest).filter((pr) => Boolean(pr.number));
  if (prs.length === 0) {
    return null;
  }
  const readiness = deriveAggregateProjectPrReadiness(prs);

  return {
    number: -1,
    status: deriveAggregateProjectPrStatus(prs),
    draft: prs.some((pr) => pr.draft),
    mergeable: prs.length === readyTargets.length && prs.every((pr) => pr.mergeable),
    mergeStateStatus: null,
    reviewDecision: prs.some((pr) => pr.reviewDecision === "CHANGES_REQUESTED")
      ? "CHANGES_REQUESTED"
      : prs.some((pr) => pr.reviewDecision === "REVIEW_REQUIRED")
        ? "REVIEW_REQUIRED"
        : prs.every((pr) => pr.reviewDecision === "APPROVED")
          ? "APPROVED"
          : null,
    requiredChecks: prs.flatMap((pr) => pr.requiredChecks),
    aggregateReadiness: readiness,
  };
}

function deriveAggregateProjectPrStatus(prs: TaskPullRequest[]): TaskPullRequest["status"] {
  if (prs.some((pr) => pr.status === "open")) {
    return "open";
  }
  if (prs.every((pr) => pr.status === "merged")) {
    return "merged";
  }
  if (prs.some((pr) => pr.status === "closed")) {
    return "closed";
  }
  return prs[0]?.status ?? null;
}

function deriveAggregateProjectPrReadiness(prs: TaskPullRequest[]): PrReadinessStatus {
  const statuses = prs.map((pr) => getPrReadinessStatus(pr));
  if (statuses.some((status) => status === "failed")) {
    return "failed";
  }
  if (statuses.some((status) => status === "pending")) {
    return "pending";
  }
  if (statuses.length > 0 && statuses.every((status) => status === "success")) {
    return "success";
  }
  return "none";
}

function buildPrLifecycleSegment(pr: { number: number | null; status: string | null; draft?: boolean } | null): TerminalRowSegment {
  if (!pr || !pr.number) return { text: PR_ICON_NONE, style: { fg: "565f89" } };
  if (pr.status === "merged") return { text: PR_ICON_MERGED, style: { fg: "9d7cd8" } };
  if (pr.status === "closed") return { text: PR_ICON_CLOSED, style: { fg: "f7768e" } };
  if (pr.status === "draft" || pr.draft) return { text: PR_ICON_OPEN, style: { fg: "565f89" } };
  return { text: PR_ICON_OPEN, style: { fg: "9ece6a" } };
}

function buildPrReadinessSegment(pr: PrBadgeDetail | null): TerminalRowSegment {
  if (pr?.aggregateReadiness) {
    return renderPrReadinessStatus(pr.aggregateReadiness);
  }
  return renderPrReadinessStatus(getPrReadinessStatus(pr));
}

function renderPrReadinessStatus(status: PrReadinessStatus): TerminalRowSegment {
  if (status === "failed") return { text: CHECK_ICON_FAILED, style: { fg: "f7768e" } };
  if (status === "pending") return { text: CHECK_ICON_PENDING, style: { fg: "e0af68" } };
  if (status === "success") return { text: CHECK_ICON_SUCCESS, style: { fg: "9ece6a" } };
  return { text: CHECK_ICON_NONE, style: { fg: "565f89" } };
}

function getPrReadinessStatus(pr: PrBadgeDetail | null): PrReadinessStatus {
  const checks = pr?.requiredChecks ?? null;
  if (pr?.status === "merged") return "success";
  if (pr?.status === "closed") return "none";
  if (!pr?.number || !checks || checks.length === 0) return "none";
  if (checks.some((c) => c.status === "failed") || pr.reviewDecision === "CHANGES_REQUESTED") return "failed";
  if (!checks.every((c) => c.status === "success" || c.status === "skipped")) return "pending";
  if (isPrReviewBlocked(pr)) return "failed";
  if (isPrReadyToMerge(pr)) return "success";
  return "pending";
}

function isPrReadyToMerge(pr: PrBadgeDetail): boolean {
  return Boolean(
    pr.mergeable &&
    !pr.draft &&
    !isPrReviewBlocked(pr) &&
    pr.requiredChecks.length > 0 &&
    pr.requiredChecks.every((check) => check.status === "success" || check.status === "skipped"),
  );
}

function isPrReviewBlocked(pr: Pick<PrBadgeDetail, "mergeStateStatus" | "reviewDecision">): boolean {
  return (
    pr.reviewDecision === "REVIEW_REQUIRED" ||
    pr.reviewDecision === "CHANGES_REQUESTED" ||
    pr.mergeStateStatus === "REVIEW_REQUIRED"
  );
}

function buildReviewInspectionRows(
  state: ControlShellState,
  task: TaskRecord | null,
): ShellInspectionRow[] {
  if (!task) {
    return [{ id: "review-empty", text: "No task selected.", muted: true }];
  }

  if (task.type === "project" && task.repoTargets?.length) {
    return buildProjectReviewInspectionRows(state, task);
  }

  const primaryPr = getTaskPrimaryPr(task);
  const rows = buildPrDetailRows("pr", task.branch, primaryPr ?? { number: null, url: null, baseBranch: null, headBranch: null, draft: false, mergeable: false, mergeStateStatus: null, reviewDecision: null, lastSyncedAt: null, requiredChecks: [], comments: [] });
  const prHistoryCount = task.prs.filter(
    (pr) => pr !== primaryPr && (pr.status === "merged" || pr.status === "closed"),
  ).length;
  if (prHistoryCount > 0) {
    rows.push({ id: "pr-history", text: `+ ${prHistoryCount} previous PR${prHistoryCount !== 1 ? "s" : ""}`, muted: true });
  }
  return applyReviewScrollAnchor(rows, state);
}

const TARGET_ROW_WIDTH = 32;

function buildProjectReviewInspectionRows(
  state: ControlShellState,
  task: TaskRecord,
): ShellInspectionRow[] {
  const rows: ShellInspectionRow[] = [];
  const targets = task.repoTargets ?? [];
  const selectedTargetId = state.selectedProjectTargetId ?? targets[0]?.repoId ?? null;

  for (const target of targets) {
    const selected = selectedTargetId === target.repoId;
    const focused = state.focusedRegion === "inspector" && selected;
    const repoLabel = target.repoId.startsWith("repo_") ? target.repoId.slice(5) : target.repoId;

    if (target.status !== "ready") {
      const statusText = target.failureReason ? target.failureReason.slice(0, 14) : target.status;
      const right = statusText;
      const maxLeft = TARGET_ROW_WIDTH - right.length - 1;
      const label = repoLabel.length > maxLeft ? repoLabel.slice(0, maxLeft - 1) + "…" : repoLabel;
      const spaces = TARGET_ROW_WIDTH - label.length - right.length;
      rows.push({
        id: `project-review:${target.repoId}`,
        text: label + " ".repeat(Math.max(1, spaces)) + right,
        selected,
        focused,
        muted: true,
      });
    } else {
      const prIcon = buildPrLifecycleSegment(target.pullRequest);
      const checkIcon = buildPrReadinessSegment(target.pullRequest);
      const right = `${prIcon.text} ${checkIcon.text}`;
      const maxLeft = TARGET_ROW_WIDTH - right.length - 1;
      const label = repoLabel.length > maxLeft ? repoLabel.slice(0, maxLeft - 1) + "…" : repoLabel;
      const spaces = TARGET_ROW_WIDTH - label.length - right.length;
      const leftPadded = label + " ".repeat(Math.max(1, spaces));
      rows.push({
        id: `project-review:${target.repoId}`,
        text: leftPadded + right,
        selected,
        focused,
        segments: [
          { text: leftPadded },
          { ...prIcon, text: prIcon.text },
          { text: " " },
          { ...checkIcon, text: checkIcon.text },
        ],
      });
    }
  }

  const selectedTarget = targets.find((t) => t.repoId === selectedTargetId) ?? null;
  if (selectedTarget?.status === "ready" && selectedTarget.pullRequest.number) {
    rows.push({ id: "target-detail-spacer", text: "" });
    rows.push(...buildPrDetailRows("target", selectedTarget.branch, selectedTarget.pullRequest));
  }

  return rows;
}

export function getReviewInspectionRowCount(state: ControlShellState, task: TaskRecord | null): number {
  return buildReviewInspectionRows(state, task).length;
}

interface PrDetail {
  number: number | null;
  url: string | null;
  baseBranch: string | null;
  headBranch: string | null;
  draft?: boolean;
  mergeable: boolean;
  mergeStateStatus: string | null;
  reviewDecision?: TaskPullRequest["reviewDecision"];
  lastSyncedAt: string | null;
  requiredChecks: TaskPullRequestCheck[];
  comments?: TaskPullRequestComment[];
}

function buildPrDetailRows(
  idPrefix: string,
  fallbackBranch: string,
  pr: PrDetail,
): ShellInspectionRow[] {
  const id = (suffix: string) => `${idPrefix}-${suffix}`;

  if (!pr.number) {
    return [{ id: id("no-pr"), text: fallbackBranch, muted: true }];
  }

  const rows: ShellInspectionRow[] = [];

  const prNumberText = `#${pr.number}`;
  rows.push(
    pr.url
      ? {
          id: id("pr-number"),
          text: `${prNumberText}  Open in GitHub ↗`,
          segments: [
            { text: prNumberText },
            { text: "  Open in GitHub ↗", style: { fg: "7aa2f7", underline: true }, href: pr.url },
          ],
        }
      : { id: id("pr-number"), text: prNumberText },
  );

  const base = pr.baseBranch ?? "?";
  const head = pr.headBranch ?? fallbackBranch;
  rows.push({ id: id("pr-branches"), text: `${base} → ${head}`, muted: true });

  const reviewText = formatReviewDecision(pr.reviewDecision, pr.mergeStateStatus);
  const mergeText = reviewText && reviewText !== "review approved"
    ? "merge blocked"
    : pr.mergeable
    ? "merge ready"
    : pr.mergeStateStatus
      ? `merge ${pr.mergeStateStatus}`
      : "merge unknown";
  if (reviewText) {
    rows.push({
      id: id("pr-merge"),
      text: `${mergeText} · ${reviewText}`,
      muted: true,
      segments: [
        { text: mergeText },
        { text: " · " },
        { text: reviewText, style: { fg: formatReviewDecisionColor(pr.reviewDecision, pr.mergeStateStatus) } },
      ],
    });
  } else {
    rows.push({ id: id("pr-merge"), text: mergeText, muted: true });
  }
  rows.push({ id: id("pr-synced"), text: `synced ${formatRelativeTime(pr.lastSyncedAt)}`, muted: true });

  rows.push({ id: id("checks-spacer"), text: "" });
  rows.push({ id: id("checks-header"), text: "Checks" });

  if (!pr.requiredChecks.length) {
    rows.push({ id: id("checks-none"), text: pr.number ? "No GitHub checks reported." : "No checks — sync after creating a PR.", muted: true });
  } else {
    rows.push(...pr.requiredChecks.map(renderPullRequestCheckRow));
  }

  const comments = pr.comments ?? [];
  if (comments.length > 0) {
    rows.push({ id: id("comments-spacer"), text: "" });
    rows.push({ id: id("comments-header"), text: `Review comments (${comments.length})` });
    rows.push(...comments.slice(-4).flatMap((comment, index) => renderPullRequestCommentRows(comment, id(`comment:${index}`))));
  }

  return rows;
}

function applyReviewScrollAnchor(rows: ShellInspectionRow[], state: ControlShellState): ShellInspectionRow[] {
  if (state.focusedRegion !== "inspector" || state.inspectionMode !== "review" || rows.length === 0) {
    return rows;
  }

  const targetIndex = Math.max(0, Math.min(state.reviewScrollOffset, rows.length - 1));
  return rows.map((row, index) => ({
    ...row,
    selected: state.reviewScrollOffset === 0 ? row.selected || index === targetIndex : index === targetIndex,
    focused: state.reviewScrollOffset === 0 ? row.focused || index === targetIndex : index === targetIndex,
  }));
}

function formatReviewDecision(reviewDecision: PrDetail["reviewDecision"], mergeStateStatus: string | null): string | null {
  if (reviewDecision === "CHANGES_REQUESTED") {
    return "review changes requested";
  }
  if (reviewDecision === "REVIEW_REQUIRED" || mergeStateStatus === "REVIEW_REQUIRED") {
    return "review required";
  }
  if (reviewDecision === "APPROVED") {
    return "review approved";
  }
  return null;
}

function formatReviewDecisionColor(reviewDecision: PrDetail["reviewDecision"], mergeStateStatus: string | null): string {
  if (reviewDecision === "CHANGES_REQUESTED") {
    return "f7768e";
  }
  if (reviewDecision === "APPROVED") {
    return "9ece6a";
  }
  if (reviewDecision === "REVIEW_REQUIRED" || mergeStateStatus === "REVIEW_REQUIRED") {
    return "e0af68";
  }
  return "565f89";
}

function formatRelativeTime(isoString: string | null): string {
  if (!isoString) return "--";
  const diffMs = Date.now() - new Date(isoString).getTime();
  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function renderPullRequestCheckRow(check: TaskPullRequestCheck): ShellInspectionRow {
  const { icon, color } = formatCheckStatus(check.status);
  const label = check.name.length > 16 ? `${check.name.slice(0, 15)}…` : check.name;
  return {
    id: `pr-check:${check.name}`,
    text: `${icon} ${label.padEnd(16, " ")} ${formatPullRequestCheckStatus(check.status)}`,
    color,
    muted: false,
  };
}

function renderPullRequestCommentRows(comment: TaskPullRequestComment, id: string): ShellInspectionRow[] {
  const author = comment.author ?? "unknown";
  const timestamp = comment.createdAt ? ` · ${formatRelativeTime(comment.createdAt)}` : "";
  const wrappedBodyLines = wrapTerminalText(comment.body, 30);
  const bodyLines = wrappedBodyLines.slice(0, 4);
  const clipped = bodyLines.length < wrappedBodyLines.length;
  const rows: ShellInspectionRow[] = [
    { id: `${id}:author`, text: `${author}${timestamp}`, muted: true },
    ...bodyLines.map((line, index) => ({
      id: `${id}:body:${index}`,
      text: `  ${clipped && index === bodyLines.length - 1 ? `${line}…` : line}`,
      muted: true,
    })),
  ];
  rows.push({ id: `${id}:spacer`, text: "", muted: true });
  return rows;
}

function wrapTerminalText(value: string, maxLength: number): string[] {
  const words = value.split(/\s+/).filter(Boolean);
  if (words.length === 0) {
    return [];
  }

  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    if (!current) {
      current = word;
      continue;
    }

    if (`${current} ${word}`.length <= maxLength) {
      current = `${current} ${word}`;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current) {
    lines.push(current);
  }
  return lines;
}

function formatCheckStatus(status: TaskPullRequestCheck["status"]): { icon: string; color: string } {
  switch (status) {
    case "success": return { icon: CHECK_ICON_SUCCESS, color: "9ece6a" };
    case "pending": return { icon: CHECK_ICON_PENDING, color: "e0af68" };
    case "failed":  return { icon: CHECK_ICON_FAILED, color: "f7768e" };
    case "skipped": return { icon: CHECK_ICON_NONE, color: "565f89" };
    default:        return { icon: "?", color: "565f89" };
  }
}

function formatPullRequestCheckStatus(status: TaskPullRequestCheck["status"]): string {
  if (status === "success") {
    return "passing";
  }
  if (status === "failed") {
    return "failing";
  }
  return status;
}


function buildFileInspectionRows(state: ControlShellState, inspection: TaskLocalInspection | null): ShellInspectionRow[] {
  if (!inspection) {
    return [{ id: "empty", text: "No file index. Select a task with local changes.", muted: true }];
  }

  if (inspection.error) {
    return [{ id: "error", text: inspection.error, muted: true }];
  }

  if (inspection.fileRows.length === 0) {
    return [{ id: "empty", text: "No Git-visible files.", muted: true }];
  }

  const changedPaths = new Map(inspection.diffRows.map((row) => [row.path, row.status]));
  const visibleRows = getVisibleFileTreeRows(inspection.fileRows, state.collapsedFileTreePaths);
  const selectedTreePath = state.selectedFileTreePath ?? inspection.selectedFilePath;
  return visibleRows.map((row) => {
    const gitStatus = row.kind === "file" ? changedPaths.get(row.path) : undefined;
    const color = gitStatus === "A" ? "9ece6a"
      : gitStatus === "M" ? "e0af68"
      : gitStatus === "D" ? "f7768e"
      : gitStatus === "??" ? "565f89"
      : undefined;
    const icon = row.kind === "directory"
      ? (state.collapsedFileTreePaths.includes(row.path) ? DIR_ICON_CLOSED : DIR_ICON_OPEN)
      : getFileIcon(row.label);
    const iconColor = row.kind === "directory" ? "7aa2f7" : getFileIconColor(row.label);
    const indent = "  ".repeat(row.depth);
    const iconSegment: TerminalRowSegment = iconColor ? { text: icon, style: { fg: iconColor } } : { text: icon };
    const labelSegment: TerminalRowSegment = row.kind === "directory"
      ? { text: row.label, style: { fg: "7aa2f7" } }
      : color
        ? { text: row.label, style: { fg: color } }
        : { text: row.label };
    const segments: TerminalRowSegment[] = [{ text: indent }, iconSegment, labelSegment];
    return {
      id: row.path,
      text: `${indent}${icon}${row.label}`,
      selected: row.path === selectedTreePath,
      focused: row.path === selectedTreePath && state.focusedRegion === "inspector",
      segments,
    };
  });
}

function getVisibleFileTreeRows(rows: TaskLocalInspection["fileRows"], collapsedPaths: string[]): TaskLocalInspection["fileRows"] {
  const collapsed = new Set(collapsedPaths);
  return rows.filter((row) => {
    const parts = row.path.split("/");
    for (let index = 1; index < parts.length; index += 1) {
      if (collapsed.has(parts.slice(0, index).join("/"))) {
        return false;
      }
    }
    return true;
  });
}


function buildDiffInspectionRows(state: ControlShellState, inspection: TaskLocalInspection | null): ShellInspectionRow[] {
  if (!inspection) {
    return [{ id: "empty", text: "No task diff index.", muted: true }];
  }

  if (inspection.error) {
    return [{ id: "error", text: inspection.error, muted: true }];
  }

  if (inspection.diffRows.length === 0) {
    const projectHint = inspection.filePaths.some((filePath) => filePath.startsWith("repo_"))
      ? "No changes in project task worktrees. Edits in the original repos are outside this task."
      : "No local changes.";
    return [{ id: "empty", text: projectHint, muted: true }];
  }

  if (isProjectInspection(inspection)) {
    return buildProjectDiffInspectionRows(state, inspection);
  }

  const rows: ShellInspectionRow[] = [];
  for (const group of ["branch", "staged", "unstaged", "untracked"] as InspectionDiffGroup[]) {
    const groupRows = inspection.diffRows.filter((row) => row.group === group);
    if (groupRows.length === 0) {
      continue;
    }

    rows.push({ id: group, text: group.toUpperCase(), muted: true });
    rows.push(...groupRows.map((row) => renderDiffInspectionRow(row, state, inspection)));
  }

  return rows;
}

function isProjectInspection(inspection: TaskLocalInspection): boolean {
  return inspection.filePaths.some((filePath) => filePath.startsWith("repo_")) ||
    inspection.diffRows.some((row) => row.path.startsWith("repo_"));
}

function buildProjectDiffInspectionRows(state: ControlShellState, inspection: TaskLocalInspection): ShellInspectionRow[] {
  const rows: ShellInspectionRow[] = [];
  const repoIds = [...new Set(inspection.diffRows.map((row) => row.path.split("/")[0]).filter((repoId): repoId is string => typeof repoId === "string" && repoId.length > 0))].sort();

  for (const repoId of repoIds) {
    const repoRows = inspection.diffRows.filter((row) => row.path.startsWith(`${repoId}/`));
    const repoLabel = repoId.startsWith("repo_") ? repoId.slice(5) : repoId;
    rows.push({ id: `repo-diff:${repoId}`, text: repoLabel, muted: true });

    for (const group of ["branch", "staged", "unstaged", "untracked"] as InspectionDiffGroup[]) {
      const groupRows = repoRows.filter((row) => row.group === group);
      if (groupRows.length === 0) {
        continue;
      }
      rows.push({ id: `repo-diff:${repoId}:${group}`, text: `  ${group}`, muted: true });
      rows.push(...groupRows.map((row) => renderDiffInspectionRow(row, state, inspection, repoId.length + 1)));
    }
  }

  return rows;
}

function renderDiffInspectionRow(
  row: InspectionDiffRow,
  state: ControlShellState,
  inspection: TaskLocalInspection,
  trimPrefixLength = 0,
): ShellInspectionRow {
  const additions = row.additions === null ? "-" : `+${row.additions}`;
  const deletions = row.deletions === null ? "-" : `-${row.deletions}`;
  const color = row.status === "A" || row.group === "untracked" ? "9ece6a"
    : row.status === "D" ? "f7768e"
    : "e0af68";
  const displayPath = trimPrefixLength > 0 ? row.path.slice(trimPrefixLength) : row.path;
  return {
    id: `${row.group}:${row.path}`,
    text: `  ${row.status.padEnd(2, " ")} ${displayPath} ${additions}/${deletions}`,
    selected: row.path === (state.selectedDiffPath ?? inspection.selectedDiffPath),
    focused: row.path === (state.selectedDiffPath ?? inspection.selectedDiffPath) && state.focusedRegion === "inspector",
    color,
  };
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
    { label: "Agent", value: getRunnerDisplayName(task.runner) },
    { label: "Branch", value: task.branch },
    { label: "Status", value: task.status },
    { label: "Worktree", value: path.basename(task.worktreePath) },
  ];
}

function countRunners(tasks: TaskRecord[]): Record<RunnerType, number> {
  return tasks.reduce(
    (counts, task) => {
      counts[task.runner] += 1;
      return counts;
    },
    { codex: 0, cursor: 0, claude: 0 },
  );
}

function renderRunnerRow(name: RunnerType, count: number): ShellRunnerRow {
  return {
    name: getRunnerDisplayName(name).toLowerCase(),
    health: count > 0 ? 1.0 : 0.0,
    count: String(count),
  };
}
