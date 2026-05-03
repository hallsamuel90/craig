export interface MockTopRail {
  workspacePath: string;
  agent: string;
  liveLabel: string;
}

export interface MockTreeRow {
  text: string;
  indent?: number;
  selected?: boolean;
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
  label: string;
  active?: boolean;
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
  label: string;
  shortcut: string;
  selected?: boolean;
}

export interface MockShellData {
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

export function getMockShellData(): MockShellData {
  return {
    topRail: {
      workspacePath: "~/workspaces/craig/colombo",
      agent: "codex",
      liveLabel: "live",
    },
    leftTree: [
      { text: "WORKSPACES", muted: true },
      { text: "▾ craig" },
      { text: "▾ main", indent: 2 },
      { text: "└ task_20260430_01", indent: 4, muted: true },
      { text: "▾ bug-fixes", indent: 2 },
      { text: "▸ task_20260430_02", indent: 1, selected: true, status: "running", accentDot: true },
      { text: "task_20260430_03", indent: 6 },
      { text: "▾ what-up-dennys", indent: 2 },
      { text: "└ task_20260430_03", indent: 4, muted: true },
      { text: "▾ testing", indent: 2 },
      { text: "└ task_20260430_04", indent: 4, muted: true },
      { text: "▾ whats-our-test-coverage", indent: 2 },
      { text: "└ task_20260430_05", indent: 4, muted: true },
    ],
    runners: [
      { name: "codex", meter: "[##########]", count: "6" },
      { name: "cursor", meter: "[##########]", count: "2" },
    ],
    centerHeader: {
      tabLabel: "AGENT",
      taskId: "task_20260430_02",
      repo: "bug-fixes",
      agent: "codex",
    },
    centerTranscript: [
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
    ],
    tabs: [
      { label: "AGENT", active: true },
      { label: "FILES" },
      { label: "DIFF" },
      { label: "TERMINAL" },
      { label: "LOGS" },
    ],
    rightContext: [
      { label: "Task", value: "task_20260430_02" },
      { label: "Repo", value: "bug-fixes" },
      { label: "Agent", value: "codex" },
      { label: "Branch", value: "task/interactive-shell" },
      { label: "Started", value: "20:18:42" },
      { label: "Status", value: "running" },
      { label: "Changes", value: "+3    -2" },
    ],
    rightChecks: [
      { status: "✓", label: "Lint", result: "OK", duration: "5s", success: true },
      { status: "✓", label: "Typecheck", result: "OK", duration: "7s", success: true },
      { status: "✓", label: "Tests", result: "OK", duration: "12s", success: true },
      { status: "○", label: "Build", result: "pending", duration: "--" },
      { status: "○", label: "Docker Build", result: "pending", duration: "--" },
    ],
    rightActions: [
      { label: "commit", shortcut: "c", selected: true },
      { label: "push", shortcut: "p" },
      { label: "create pr", shortcut: "P" },
      { label: "merge", shortcut: "m" },
      { label: "close task", shortcut: "x" },
    ],
    rightNextAction: "Run the build, then open the PR.",
  };
}
