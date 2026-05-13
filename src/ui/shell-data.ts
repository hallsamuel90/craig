import path from "node:path";

import type { InspectionDiffGroup, InspectionDiffRow, TaskLocalInspection } from "../services/task-local-inspection.js";
import { DIR_ICON_CLOSED, DIR_ICON_OPEN, getFileIcon, getFileIconColor } from "./icons.js";
import type { RunnerType, TaskPullRequest, TaskPullRequestCheck, TaskPtyTabRecord, TaskRecord } from "../types/task.js";
import type { RepoRecord } from "../types/workspace.js";
import { getRunnerDisplayName } from "../services/runner-profiles.js";
import { INSPECTION_TAB_ID } from "./state.js";
import type { TerminalCellStyle, TerminalRowSegment } from "./terminal-emulator.js";
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
  centerTranscript: ShellCenterLine[];
  tabs: ShellTab[];
  rightContext: ShellContextRow[];
  rightInspection: ShellInspectionSection | null;
  rightChecks: ShellCheckRow[];
  rightActions: ShellActionRow[];
}

export interface WorkspaceShellModel {
  repos: RepoRecord[];
  tasks: TaskRecord[];
  workspaceRoot: string;
  inspection: TaskLocalInspection | null;
}

export interface DiffPathRange {
  path: string;
  start: number;
  end: number;
}

const ACTION_FIXTURES: Array<{ id: ActionId; label: string; shortcut: string }> = [
  { id: "commit", label: "commit", shortcut: "c" },
  { id: "push", label: "push", shortcut: "p" },
  { id: "create-pr", label: "create pr", shortcut: "P" },
  { id: "refresh-checks", label: "refresh checks", shortcut: "R" },
  { id: "merge", label: "merge", shortcut: "M" },
  { id: "close-task", label: "close task", shortcut: "X" },
];
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
  const selectedRepo = model.repos.find((repo) => repo.id === state.selectedRepoId) ?? model.repos[0] ?? null;
  const repoTasks = selectedRepo ? model.tasks.filter((task) => task.repoId === selectedRepo.id) : [];
  const selectedTask = repoTasks.find((task) => task.id === state.selectedTaskId) ?? repoTasks[0] ?? null;
  const runnerCounts = countRunners(model.tasks);
  const activeTabId = resolveDisplayActiveTab(state, selectedTask);
  const tabs = buildCenterTabs(state, selectedTask, activeTabId);
  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? tabs[0] ?? { id: "agent", label: "CODEX" };
  const selectedInspection = model.inspection?.taskId === selectedTask?.id ? model.inspection : null;
  const repoLabel = selectedRepo?.name ?? "no repo";
  const agentLabel = selectedTask ? getRunnerDisplayName(selectedTask.runner) : getRunnerDisplayName(state.selectedRunner);
  const checkRows = buildCheckRows(selectedTask);

  return {
    inputMode: state.inputMode,
    focusedRegion: state.focusedRegion,
    actionMessage: state.actionMessage,
    terminal: state.terminal,
    footerText:
      state.workspaceBrowser !== null
        ? `BROWSE WORKSPACE ${state.workspaceBrowser.cwd}   ↑↓ move   → open   ← up   Enter add repo`
        : state.taskPromptInput !== null
        ? `NEW TASK ${selectedRepo ? `[${selectedRepo.name}]` : "[no repo]"} ${getRunnerDisplayName(state.selectedRunner)} Ctrl+R runner: ${state.taskPromptInput}${state.taskPromptError ? ` · ${state.taskPromptError}` : ""}`
        : state.inputMode === "terminal"
        ? "TERMINAL   ↑↓/PgUp/PgDn scroll   Ctrl+] detach"
        : state.focusedRegion === "tasks"
          ? `NORMAL   n new task   r runner: ${getRunnerDisplayName(state.selectedRunner)}   Enter attach   X close task`
        : state.focusedRegion === "center"
          ? activeTabId === INSPECTION_TAB_ID
            ? "NORMAL   ↑↓/wheel/PgUp/PgDn scroll   ←/→ switch   Tab inspector"
            : "NORMAL   + new tab   a Codex   t Terminal   x close tab   Enter attach"
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
      renderRunnerRow("claude", runnerCounts.claude),
    ],
    centerHeader: {
      tabLabel: state.workspaceBrowser ? "BROWSER" : activeTab.label,
      taskId: state.workspaceBrowser ? "new workspace" : selectedTask?.id ?? "no task",
      repo: repoLabel,
      agent: agentLabel,
    },
    centerTranscript: buildCenterTranscript(activeTabId, state, selectedRepo, selectedTask, state.workspaceBrowser, selectedInspection),
    tabs,
    rightContext: buildContextRows(selectedRepo, selectedTask),
    rightInspection: buildInspectionSection(state, selectedTask, selectedInspection, buildActionRows(state)),
    rightChecks: checkRows,
    rightActions: buildActionRows(state),
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
          text: `${prefix} ${task.id} [${task.runner}]`,
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
    text: `+ New Task [${getRunnerDisplayName(state.selectedRunner)}]`,
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
  state: ControlShellState,
  repo: RepoRecord | null,
  task: TaskRecord | null,
  browser: WorkspaceBrowserState | null,
  inspection: TaskLocalInspection | null = null,
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
    return textLines([
      `Repo ${repo.name} is ready.`,
      "",
      "Press n to create a task and boot the selected runner in its worktree.",
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
  const inspectionTab = state.openInspectionKind
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
    return state.activeTab === INSPECTION_TAB_ID ? state.activeTab : "agent";
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
  const base = selectedPath ? path.basename(selectedPath) : "Inspect";
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

  const diffRows = buildCombinedDiffLines(inspection);
  const start = Math.max(0, Math.min(scrollOffset, Math.max(0, diffRows.length - 1)));
  return [
    { text: "All changes" },
    {
      text: `${inspection.diffPaths.length} files · ${diffRows.length} rows · PgUp/PgDn or wheel scroll`,
      tone: "muted",
    },
    { text: "" },
    ...diffRows.slice(start),
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

function buildCombinedDiffLines(inspection: TaskLocalInspection): ShellCenterLine[] {
  const rows: ShellCenterLine[] = [];
  for (const diffPath of inspection.diffPaths) {
    const content = inspection.diffContents[diffPath] ?? inspection.selectedDiff;
    const language = detectLanguage(content.path ?? content.title);
    rows.push({ text: content.title, tone: "muted" });
    rows.push(...renderUnifiedDiffLines(content.lines, 0, language));
    rows.push({ text: "" });
  }

  return rows.length > 0 ? rows : textLines(["No local changes."]);
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
  actions: ShellActionRow[],
): ShellInspectionSection | null {
  const modeRows = [renderInspectionModeRow(state, task), { id: "mode-spacer", text: "", muted: true }];
  if (state.inspectionMode === "review") {
    return {
      title: "",
      rows: [...modeRows, ...buildReviewInspectionRows(state, task, actions)],
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

function renderInspectionModeRow(state: ControlShellState, task: TaskRecord | null): ShellInspectionRow {
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
    segments.push({ text: m.label, style: { fg: m.active ? "7aa2f7" : "565f89" } });
  }

  const prSegment = buildPrLifecycleSegment(task?.pullRequest ?? null);
  const checksSegment = buildPrChecksSegment(task?.pullRequest?.requiredChecks ?? null);
  segments.push({ text: "  " }, prSegment, { text: " " }, checksSegment);

  const text = segments.map((s) => s.text).join("");
  return { id: "inspection-mode", text, segments };
}

function buildPrLifecycleSegment(pr: TaskPullRequest | null): TerminalRowSegment {
  if (!pr || !pr.number) return { text: "○", style: { fg: "565f89" } };
  if (pr.status === "merged") return { text: "⊕", style: { fg: "9d7cd8" } };
  if (pr.status === "closed") return { text: "⊗", style: { fg: "f7768e" } };
  return { text: "⊙", style: { fg: "9ece6a" } };
}

function buildPrChecksSegment(checks: TaskPullRequestCheck[] | null): TerminalRowSegment {
  if (!checks || checks.length === 0) return { text: "—", style: { fg: "565f89" } };
  if (checks.some((c) => c.status === "failed")) return { text: "✕", style: { fg: "f7768e" } };
  if (checks.every((c) => c.status === "success")) return { text: "✓", style: { fg: "9ece6a" } };
  return { text: "◌", style: { fg: "e0af68" } };
}

function buildActionRows(state: ControlShellState): ShellActionRow[] {
  return ACTION_FIXTURES.map((action) => ({
    ...action,
    selected: action.id === state.selectedActionId,
    focused: state.focusedRegion === "actions" && action.id === state.selectedActionId,
  }));
}

function buildReviewInspectionRows(
  state: ControlShellState,
  task: TaskRecord | null,
  actions: ShellActionRow[],
): ShellInspectionRow[] {
  if (!task) {
    return [{ id: "review-empty", text: "No task selected.", muted: true }];
  }

  const pr = task.pullRequest;
  const createPrAction = actions.find((action) => action.id === "create-pr");
  const refreshChecksAction = actions.find((action) => action.id === "refresh-checks");
  const mergeAction = actions.find((action) => action.id === "merge");
  const closeTaskAction = actions.find((action) => action.id === "close-task");
  const actionLabel = pr.number ? "sync pr" : "create pr";
  const reviewActionRows = [
    renderReviewActionRow("create-pr", actionLabel, createPrAction?.shortcut ?? "P", state),
    renderReviewActionRow("refresh-checks", "refresh checks", refreshChecksAction?.shortcut ?? "R", state, !pr.number),
    renderReviewActionRow("merge", "merge pr", mergeAction?.shortcut ?? "M", state, !isReviewMergeActionAvailable(task)),
    renderReviewActionRow("close-task", "close task", closeTaskAction?.shortcut ?? "X", state, task.status === "closed"),
  ];
  const rows: ShellInspectionRow[] = [
    { id: "review-title", text: "PR", muted: true },
    pr.number
      ? { id: "pr-number", text: `#${pr.number} ${pr.status ?? "unknown"}` }
      : { id: "pr-number", text: "No PR — press P to create one.", muted: true },
    { id: "pr-url", text: pr.url ?? "not created", muted: pr.url === null },
    { id: "pr-base", text: `base ${pr.baseBranch ?? "unknown"}`, muted: pr.baseBranch === null },
    { id: "pr-head", text: `head ${pr.headBranch ?? task.branch}`, muted: pr.headBranch === null },
    { id: "pr-merge", text: `merge ${pr.mergeable ? "ready" : pr.mergeStateStatus ?? "unknown"}` },
    { id: "pr-synced", text: `synced ${formatNullableValue(pr.lastSyncedAt)}`, muted: pr.lastSyncedAt === null },
    { id: "pr-sha", text: `sha ${formatNullableSha(pr.lastSyncedHeadSha)}`, muted: pr.lastSyncedHeadSha === null },
    { id: "review-spacer", text: "" },
    { id: "review-checks", text: "Checks", muted: true },
    ...buildPullRequestCheckRows(task),
    { id: "review-guidance-spacer", text: "" },
    renderReviewGuidance(task),
    { id: "review-action-spacer", text: "" },
    ...reviewActionRows,
  ];

  return rows;
}

function renderReviewActionRow(
  id: ActionId,
  label: string,
  shortcut: string,
  state: ControlShellState,
  muted = false,
): ShellInspectionRow {
  return {
    id,
    text: `${label.padEnd(18, " ")} ${shortcut}`,
    selected: id === state.selectedActionId,
    focused:
      state.focusedRegion === "inspector" &&
      state.inspectionMode === "review" &&
      id === state.selectedActionId,
    muted,
  };
}

function buildPullRequestCheckRows(task: TaskRecord): ShellInspectionRow[] {
  if (!task.pullRequest.number) {
    return [{ id: "pr-checks-none", text: "No checks — create a PR first (P).", muted: true }];
  }

  if (task.pullRequest.requiredChecks.length === 0) {
    return [{ id: "pr-checks-empty", text: "No GitHub checks reported.", muted: true }];
  }

  return task.pullRequest.requiredChecks.map(renderPullRequestCheckRow);
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

function formatCheckStatus(status: TaskPullRequestCheck["status"]): { icon: string; color: string } {
  switch (status) {
    case "success": return { icon: "✓", color: "9ece6a" };
    case "pending": return { icon: "⟳", color: "e0af68" };
    case "failed":  return { icon: "✕", color: "f7768e" };
    case "skipped": return { icon: "○", color: "565f89" };
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

function renderReviewGuidance(task: TaskRecord): ShellInspectionRow {
  const pr = task.pullRequest;

  if (task.status === "closed") {
    return { id: "review-guidance", text: "Task closed.", muted: true };
  }

  if (task.status === "merged") {
    return { id: "review-guidance", text: "Next: close task.", accentPrefix: true };
  }

  if (!pr.number) {
    return { id: "review-guidance", text: "Next: create PR.", muted: true };
  }

  if (task.lastCommit && pr.lastSyncedHeadSha !== task.lastCommit.sha) {
    return { id: "review-guidance", text: "Next: sync PR head.", accentPrefix: true };
  }

  if (pr.requiredChecks.length === 0) {
    return { id: "review-guidance", text: "Next: refresh checks.", muted: true };
  }

  if (pr.requiredChecks.some((check) => check.status === "failed")) {
    return { id: "review-guidance", text: "Next: fix failing checks.", accentPrefix: true };
  }

  if (pr.requiredChecks.some((check) => check.status === "unknown")) {
    return { id: "review-guidance", text: "Next: refresh unknown checks.", accentPrefix: true };
  }

  if (pr.requiredChecks.some((check) => check.status === "pending")) {
    return { id: "review-guidance", text: "Next: waiting on CI.", muted: true };
  }

  if (pr.mergeable && pr.status === "open") {
    return { id: "review-guidance", text: "Next: merge PR.", accentPrefix: true };
  }

  return { id: "review-guidance", text: "Next: review PR state.", muted: true };
}

function isReviewMergeActionAvailable(task: TaskRecord): boolean {
  return (
    task.status === "merge_ready" &&
    task.pullRequest.status === "open" &&
    task.pullRequest.mergeable &&
    task.pullRequest.requiredChecks.length > 0 &&
    task.pullRequest.requiredChecks.every((check) => check.status === "success" || check.status === "skipped") &&
    task.lastCommit !== null &&
    task.pullRequest.lastSyncedHeadSha === task.lastCommit.sha
  );
}

function formatNullableValue(value: string | null): string {
  return value ?? "--";
}

function formatNullableSha(value: string | null): string {
  return value ? value.slice(0, 7) : "--";
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
    const iconColor = row.kind === "file" ? getFileIconColor(row.label) : undefined;
    const indent = "  ".repeat(row.depth);
    const iconSegment: TerminalRowSegment = iconColor ? { text: icon, style: { fg: iconColor } } : { text: icon };
    const labelSegment: TerminalRowSegment = color ? { text: row.label, style: { fg: color } } : { text: row.label };
    const segments: TerminalRowSegment[] = [{ text: indent }, iconSegment, labelSegment];
    return {
      id: row.path,
      text: `${indent}${icon}${row.label}`,
      selected: row.path === selectedTreePath,
      focused: row.path === selectedTreePath && state.focusedRegion === "inspector",
      muted: row.kind === "directory",
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
    return [{ id: "empty", text: "No local changes.", muted: true }];
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

function renderDiffInspectionRow(
  row: InspectionDiffRow,
  state: ControlShellState,
  inspection: TaskLocalInspection,
): ShellInspectionRow {
  const additions = row.additions === null ? "-" : `+${row.additions}`;
  const deletions = row.deletions === null ? "-" : `-${row.deletions}`;
  const color = row.status === "A" || row.group === "untracked" ? "9ece6a"
    : row.status === "D" ? "f7768e"
    : "e0af68";
  return {
    id: `${row.group}:${row.path}`,
    text: `  ${row.status.padEnd(2, " ")} ${row.path} ${additions}/${deletions}`,
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
