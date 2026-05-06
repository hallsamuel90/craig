import path from "node:path";

import type { InspectionDiffGroup, InspectionDiffRow, TaskLocalInspection } from "../services/task-local-inspection.js";
import type { TaskPtyTabRecord, TaskRecord } from "../types/task.js";
import type { RepoRecord } from "../types/workspace.js";
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

export interface ShellInspectionRow {
  id: string;
  text: string;
  selected?: boolean;
  focused?: boolean;
  muted?: boolean;
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

const ACTION_FIXTURES: Array<{ id: ActionId; label: string; shortcut: string }> = [
  { id: "commit", label: "commit", shortcut: "c" },
  { id: "push", label: "push", shortcut: "p" },
  { id: "create-pr", label: "create pr", shortcut: "P" },
  { id: "merge", label: "merge", shortcut: "m" },
  { id: "close-task", label: "close task", shortcut: "x" },
];
const SYNTAX_COLORS = {
  lineNumber: "858585",
  gutter: "404040",
  keyword: "569cd6",
  string: "ce9178",
  literal: "b5cea8",
  comment: "6a9955",
  markup: "4ec9b0",
  diffAdd: "6a9955",
  diffDelete: "f48771",
  diffMeta: "808080",
  diffHunk: "c586c0",
} as const;

export function buildShellData(state: ControlShellState, model: WorkspaceShellModel): ShellData {
  const selectedRepo = model.repos.find((repo) => repo.id === state.selectedRepoId) ?? model.repos[0] ?? null;
  const repoTasks = selectedRepo ? model.tasks.filter((task) => task.repoId === selectedRepo.id) : [];
  const selectedTask = repoTasks.find((task) => task.id === state.selectedTaskId) ?? repoTasks[0] ?? null;
  const runnerCounts = countRunners(model.tasks);
  const activeTabId = resolveDisplayActiveTab(state, selectedTask);
  const tabs = buildCenterTabs(state, selectedTask, activeTabId);
  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? tabs[0] ?? { id: "agent", label: "CODEX" };
  const repoLabel = selectedRepo?.name ?? "no repo";
  const agentLabel = selectedTask?.runner ?? "codex";
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
        ? `NEW TASK ${selectedRepo ? `[${selectedRepo.name}]` : "[no repo]"}: ${state.taskPromptInput}${state.taskPromptError ? ` · ${state.taskPromptError}` : ""}`
        : state.inputMode === "terminal"
        ? "TERMINAL   Ctrl+] detach   wheel/PgUp/PgDn scroll"
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
    ],
    centerHeader: {
      tabLabel: state.workspaceBrowser ? "BROWSER" : activeTab.label,
      taskId: state.workspaceBrowser ? "new workspace" : selectedTask?.id ?? "no task",
      repo: repoLabel,
      agent: agentLabel,
    },
    centerTranscript: buildCenterTranscript(activeTabId, state, selectedRepo, selectedTask, state.workspaceBrowser, model.inspection),
    tabs,
    rightContext: buildContextRows(selectedRepo, selectedTask),
    rightInspection: buildInspectionSection(state, model.inspection, checkRows, buildActionRows(state)),
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
      "Press n to create a task and boot a Codex agent tab in its worktree.",
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
      "Press a to create a Codex tab, t to create a Terminal tab, or + to create the preferred tab kind.",
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

  const content = inspection.selectedDiff;
  const language = detectLanguage(content.path ?? content.title);
  const diffRows = renderUnifiedDiffLines(content.lines, scrollOffset, language);
  return [
    { text: content.title },
    {
      text: `${content.byteLength === null ? "size unknown" : `${content.byteLength} bytes`} · ${diffRows.length} rows · PgUp/PgDn or wheel scroll`,
      tone: "muted",
    },
    { text: "" },
    ...diffRows,
  ];
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
  inspection: TaskLocalInspection | null,
  checks: ShellCheckRow[],
  actions: ShellActionRow[],
): ShellInspectionSection | null {
  const modeRows = [renderInspectionModeRow(state), { id: "mode-spacer", text: "", muted: true }];
  if (state.inspectionMode === "actions") {
    return {
      title: "",
      rows: [...modeRows, ...actions.map(renderActionInspectionRow)],
    };
  }

  if (state.inspectionMode === "checks") {
    return {
      title: "",
      rows: [...modeRows, ...checks.map(renderCheckInspectionRow)],
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

function renderInspectionModeRow(state: ControlShellState): ShellInspectionRow {
  return {
    id: "inspection-mode",
    text: formatInspectionModeRow(state.inspectionMode),
  };
}

function formatInspectionModeRow(mode: ControlShellState["inspectionMode"]): string {
  return [
    mode === "diff" ? "[CHANGES]" : "CHANGES",
    mode === "files" ? "[FILES]" : "FILES",
    mode === "checks" ? "[CHECKS]" : "CHECKS",
    mode === "actions" ? "[ACTIONS]" : "ACTIONS",
  ].join(" ");
}

function buildActionRows(state: ControlShellState): ShellActionRow[] {
  return ACTION_FIXTURES.map((action) => ({
    ...action,
    selected: action.id === state.selectedActionId,
    focused:
      (state.focusedRegion === "actions" || (state.focusedRegion === "inspector" && state.inspectionMode === "actions")) &&
      action.id === state.selectedActionId,
  }));
}

function renderActionInspectionRow(row: ShellActionRow): ShellInspectionRow {
  return {
    id: row.id,
    text: `${row.label.padEnd(18, " ")} ${row.shortcut}`,
    selected: row.selected ?? false,
    focused: row.focused ?? false,
  };
}

function renderCheckInspectionRow(row: ShellCheckRow): ShellInspectionRow {
  return {
    id: row.label,
    text: `${row.status} ${row.label.padEnd(14, " ")} ${row.result.padEnd(8, " ")} ${row.duration}`,
    muted: !row.success,
  };
}

function buildFileInspectionRows(state: ControlShellState, inspection: TaskLocalInspection | null): ShellInspectionRow[] {
  if (!inspection) {
    return [{ id: "empty", text: "No task file index.", muted: true }];
  }

  if (inspection.error) {
    return [{ id: "error", text: inspection.error, muted: true }];
  }

  if (inspection.fileRows.length === 0) {
    return [{ id: "empty", text: "No Git-visible files.", muted: true }];
  }

  const visibleRows = getVisibleFileTreeRows(inspection.fileRows, state.collapsedFileTreePaths);
  const selectedTreePath = state.selectedFileTreePath ?? inspection.selectedFilePath;
  return visibleRows.map((row) => ({
    id: row.path,
    text: `${"  ".repeat(row.depth)}${row.kind === "directory" ? directoryIcon(row.path, state.collapsedFileTreePaths) : " "} ${row.label}`,
    selected: row.path === selectedTreePath,
    focused: row.path === selectedTreePath && state.focusedRegion === "inspector",
    muted: row.kind === "directory",
  }));
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

function directoryIcon(directoryPath: string, collapsedPaths: string[]): string {
  return collapsedPaths.includes(directoryPath) ? "▸" : "▾";
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
  for (const group of ["staged", "unstaged", "untracked"] as InspectionDiffGroup[]) {
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
  return {
    id: `${row.group}:${row.path}`,
    text: `  ${row.status.padEnd(2, " ")} ${row.path} ${additions}/${deletions}`,
    selected: row.path === inspection.selectedDiffPath,
    focused: row.path === inspection.selectedDiffPath && state.focusedRegion === "inspector",
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
