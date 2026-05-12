import { describe, expect, test } from "vitest";

import type { TaskLocalInspection } from "../src/services/task-local-inspection.js";
import { getMockShellData } from "../src/ui/mock-data.js";
import { MIN_VIEWPORT } from "../src/ui/layout.js";
import { renderBootOverlayFrame, renderMainShellFrame, renderPauseOverlayFrame } from "../src/ui/render.js";
import { createInitialShellState } from "../src/ui/state.js";
import { buildShellData } from "../src/ui/shell-data.js";
import { buildTaskRecord } from "./test-helpers.js";

describe("terminal shell renderer", () => {
  test("renders the boot overlay with the CRAIG logo and menu", () => {
    const frame = renderBootOverlayFrame(MIN_VIEWPORT, { color: false, menuIndex: 0 });

    expect(frame).toContain("▄████▄");
    expect(frame).toContain("crAIg is that you?");
    expect(frame).toContain("> Start");
    expect(frame).toContain("  Options");
    expect(frame).toContain("  Exit");
  });

  test("renders the pause overlay with resume and exit actions", () => {
    const frame = renderPauseOverlayFrame(MIN_VIEWPORT, { color: false, menuIndex: 0 });

    expect(frame).toContain("CRAIG paused");
    expect(frame).toContain("> Resume");
    expect(frame).toContain("  Options");
    expect(frame).toContain("  Exit");
  });

  test("renders the three-column mock workspace shell", () => {
    const frame = renderMainShellFrame(MIN_VIEWPORT, getMockShellData(), { color: false });

    expect(frame).toContain("CRAIG");
    expect(frame).toContain("~/workspaces/craig/colombo");
    expect(frame).toContain("CRAIG  |  ~/workspaces/craig/colombo  |  codex  ● live");
    expect(frame).not.toContain("4 tasks");
    expect(frame).not.toContain("v0.1.0");
    expect(frame).not.toContain("task/interactive-shell  |");
    expect(frame).toContain("WORKSPACES");
    expect(frame).toContain("+ New Task");
    expect(frame).toContain("+ New Workspace");
    expect(frame).toContain("codex");
    expect(frame).toContain("NORMAL   n new task");
    expect(frame).toContain("▸ task_20260430_02");
    expect(frame).toContain("running ●");
    expect(frame).toContain("AGENT");
    expect(frame).toContain("TERMINAL");
    expect(frame).toContain("CONTEXT");
    expect(frame).toContain("AGENT  task_20260430_02 · bug-fixes");
    expect(frame).toContain("Press Enter on the AGENT");
    expect(frame).toContain("─────");
    expect(frame).not.toContain("│WORKSPACES");
  });

  test("renders selected mock state for tabs, tasks, actions, and placeholders", () => {
    const frame = renderMainShellFrame(
      MIN_VIEWPORT,
      getMockShellData({
        focusedRegion: "actions",
        selectedTaskId: "task_20260430_04",
        activeTab: "terminal",
        selectedActionId: "push",
        actionMessage: "Mock action: push (phase 1.2).",
      }),
      { color: false },
    );

    expect(frame).toContain("▸ task_20260430_04");
    expect(frame).toContain("TERMINAL  task_20260430_04");
    expect(frame).toContain("Press Enter on the TERMINAL");
    expect(frame).toContain("Mock action: push (phase 1.2).");
  });

  test("renders files tab with right-panel file tree and selected file content", () => {
    const task = buildTaskRecord("/tmp/craig", {
      id: "task_20260430_02",
      repoId: "repo_bug_fixes",
      workspaceId: "workspace_bug_fixes",
    });
    const data = buildShellData(
      {
        ...createInitialShellState(null),
        selectedRepoId: "repo_bug_fixes",
        selectedTaskId: task.id,
        selectedLeftItemId: `task:${task.id}`,
        activeTab: "inspection",
        inspectionMode: "files",
        openInspectionKind: "file",
        focusedRegion: "inspector",
        selectedFilePath: "src/app.ts",
      },
      {
        workspaceRoot: "/tmp/craig",
        repos: [{ id: "repo_bug_fixes", name: "bug-fixes", rootPath: "/tmp/craig", defaultBranch: "main", createdAt: "", updatedAt: "" }],
        tasks: [task],
        inspection: inspectionFixture({ selectedFilePath: "src/app.ts" }),
      },
    );

    const frame = renderMainShellFrame(MIN_VIEWPORT, data, { color: false });

    expect(frame).toContain("FILES");
    expect(frame).toContain("src/app.ts");
    expect(frame).toContain("export const app = true;");
    expect(frame).toContain("  1 │ export const app = true;");
    expect(frame).toContain("app.ts");
  });

  test("renders file content from the current scroll offset", () => {
    const task = buildTaskRecord("/tmp/craig", {
      id: "task_20260430_02",
      repoId: "repo_bug_fixes",
      workspaceId: "workspace_bug_fixes",
    });
    const data = buildShellData(
      {
        ...createInitialShellState(null),
        selectedRepoId: "repo_bug_fixes",
        selectedTaskId: task.id,
        selectedLeftItemId: `task:${task.id}`,
        activeTab: "inspection",
        inspectionMode: "files",
        openInspectionKind: "file",
        focusedRegion: "center",
        selectedFilePath: "src/app.ts",
        fileScrollOffset: 2,
      },
      {
        workspaceRoot: "/tmp/craig",
        repos: [{ id: "repo_bug_fixes", name: "bug-fixes", rootPath: "/tmp/craig", defaultBranch: "main", createdAt: "", updatedAt: "" }],
        tasks: [task],
        inspection: inspectionFixture({ selectedFilePath: "src/app.ts" }),
      },
    );

    const frame = renderMainShellFrame(MIN_VIEWPORT, data, { color: false });

    expect(frame).not.toContain("  1 │ export const app = true;");
    expect(frame).toContain("  3 │ export function run()");
  });

  test("applies syntax color segments to file content", () => {
    const task = buildTaskRecord("/tmp/craig", {
      id: "task_20260430_02",
      repoId: "repo_bug_fixes",
      workspaceId: "workspace_bug_fixes",
    });
    const data = buildShellData(
      {
        ...createInitialShellState(null),
        selectedRepoId: "repo_bug_fixes",
        selectedTaskId: task.id,
        selectedLeftItemId: `task:${task.id}`,
        activeTab: "inspection",
        inspectionMode: "files",
        openInspectionKind: "file",
        selectedFilePath: "src/app.ts",
      },
      {
        workspaceRoot: "/tmp/craig",
        repos: [{ id: "repo_bug_fixes", name: "bug-fixes", rootPath: "/tmp/craig", defaultBranch: "main", createdAt: "", updatedAt: "" }],
        tasks: [task],
        inspection: inspectionFixture({ selectedFilePath: "src/app.ts" }),
      },
    );

    const frame = renderMainShellFrame(MIN_VIEWPORT, data, { color: true });

    expect(frame).toContain("\u001B[38;2;157;124;216;48;2;10;10;10mexport");
    expect(frame).toContain("\u001B[38;2;59;66;97;48;2;10;10;10m  1");
  });

  test("renders diff tab with grouped changed files and selected patch", () => {
    const task = buildTaskRecord("/tmp/craig", {
      id: "task_20260430_02",
      repoId: "repo_bug_fixes",
      workspaceId: "workspace_bug_fixes",
    });
    const data = buildShellData(
      {
        ...createInitialShellState(null),
        selectedRepoId: "repo_bug_fixes",
        selectedTaskId: task.id,
        selectedLeftItemId: `task:${task.id}`,
        activeTab: "inspection",
        inspectionMode: "diff",
        openInspectionKind: "diff",
        focusedRegion: "inspector",
        selectedDiffPath: "src/app.ts",
      },
      {
        workspaceRoot: "/tmp/craig",
        repos: [{ id: "repo_bug_fixes", name: "bug-fixes", rootPath: "/tmp/craig", defaultBranch: "main", createdAt: "", updatedAt: "" }],
        tasks: [task],
        inspection: inspectionFixture({ selectedDiffPath: "src/app.ts" }),
      },
    );

    const frame = renderMainShellFrame(MIN_VIEWPORT, data, { color: false });

    expect(frame).toContain("CHANGES  FILES");
    expect(frame).toContain("STAGED");
    expect(frame).toContain("UNSTAGED");
    expect(frame).toContain("  1 │ export const app = false;");
    expect(frame).toContain("  1 │ export const app = true;");
    expect(frame).not.toContain("@@ -1,2 +1,2 @@");
    expect(frame).not.toContain("diff --git a/src/app.ts b/src/app.ts");
    expect(frame).toContain("  4 │   return app;");
    expect(frame).toContain("▸   M  src/app.ts");
  });

  test("renders unified diff rows with deletion and addition colors", () => {
    const task = buildTaskRecord("/tmp/craig", {
      id: "task_20260430_02",
      repoId: "repo_bug_fixes",
      workspaceId: "workspace_bug_fixes",
    });
    const data = buildShellData(
      {
        ...createInitialShellState(null),
        selectedRepoId: "repo_bug_fixes",
        selectedTaskId: task.id,
        selectedLeftItemId: `task:${task.id}`,
        activeTab: "inspection",
        inspectionMode: "diff",
        openInspectionKind: "diff",
        selectedDiffPath: "src/app.ts",
      },
      {
        workspaceRoot: "/tmp/craig",
        repos: [{ id: "repo_bug_fixes", name: "bug-fixes", rootPath: "/tmp/craig", defaultBranch: "main", createdAt: "", updatedAt: "" }],
        tasks: [task],
        inspection: inspectionFixture({ selectedDiffPath: "src/app.ts" }),
      },
    );

    const frame = renderMainShellFrame(MIN_VIEWPORT, data, { color: true });

    expect(frame).toContain("\u001B[38;2;157;124;216;48;2;42;17;17mexport");
    expect(frame).toContain("\u001B[38;2;157;124;216;48;2;16;33;15mexport");
  });

  test("renders review panel with tracked PR metadata, GitHub checks, guidance, and actions", () => {
    const task = buildTaskRecord("/tmp/craig", {
      id: "task_20260430_02",
      repoId: "repo_bug_fixes",
      workspaceId: "workspace_bug_fixes",
      pullRequest: {
        provider: "github",
        number: 17,
        url: "https://github.com/example/repo/pull/17",
        baseBranch: "main",
        headBranch: "craig/task_20260430_02",
        status: "open",
        mergeable: true,
        mergeStateStatus: "CLEAN",
        requiredChecks: [
          { name: "ci", status: "success", conclusion: "SUCCESS" },
          { name: "docs", status: "skipped", conclusion: "SKIPPED" },
        ],
        lastSyncedAt: "2026-05-06T00:00:00.000Z",
        lastSyncedHeadSha: "abcdef123456",
      },
    });
    const data = buildShellData(
      {
        ...createInitialShellState(null),
        selectedRepoId: "repo_bug_fixes",
        selectedTaskId: task.id,
        selectedLeftItemId: `task:${task.id}`,
        focusedRegion: "inspector",
        inspectionMode: "review",
      },
      {
        workspaceRoot: "/tmp/craig",
        repos: [{ id: "repo_bug_fixes", name: "bug-fixes", rootPath: "/tmp/craig", defaultBranch: "main", createdAt: "", updatedAt: "" }],
        tasks: [task],
        inspection: null,
      },
    );

    const frame = renderMainShellFrame(MIN_VIEWPORT, data, { color: false });

    expect(frame).toContain("CHANGES  FILES  REVIEW");
    expect(frame).toContain("#17 open");
    expect(frame).toContain("sha abcdef1");
    expect(frame).toContain("✓ ci");
    expect(frame).toContain("○ docs");
    expect(frame).toContain("Next: merge PR.");
    expect(frame).toContain("sync pr");
    expect(frame).toContain("refresh checks");
    expect(frame).toContain("merge pr");
    expect(frame).toContain("close task");
  });

  test("renders review guidance for failed and unknown checks", () => {
    const baseTask = buildTaskRecord("/tmp/craig", {
      id: "task_20260430_02",
      repoId: "repo_bug_fixes",
      workspaceId: "workspace_bug_fixes",
      pullRequest: {
        provider: "github",
        number: 17,
        url: "https://github.com/example/repo/pull/17",
        baseBranch: "main",
        headBranch: "craig/task_20260430_02",
        status: "open",
        mergeable: true,
        mergeStateStatus: "CLEAN",
        requiredChecks: [{ name: "ci", status: "failed", conclusion: "FAILURE" }],
        lastSyncedAt: "2026-05-06T00:00:00.000Z",
        lastSyncedHeadSha: "abcdef123456",
      },
    });
    const model = {
      workspaceRoot: "/tmp/craig",
      repos: [{ id: "repo_bug_fixes", name: "bug-fixes", rootPath: "/tmp/craig", defaultBranch: "main", createdAt: "", updatedAt: "" }],
      tasks: [baseTask],
      inspection: null,
    };
    const state = {
      ...createInitialShellState(null),
      selectedRepoId: "repo_bug_fixes",
      selectedTaskId: baseTask.id,
      selectedLeftItemId: `task:${baseTask.id}`,
      focusedRegion: "inspector" as const,
      inspectionMode: "review" as const,
    };

    const failed = renderMainShellFrame(MIN_VIEWPORT, buildShellData(state, model), { color: false });
    const unknownTask = {
      ...baseTask,
      pullRequest: {
        ...baseTask.pullRequest,
        requiredChecks: [{ name: "coverage", status: "unknown" as const, conclusion: null }],
      },
    };
    const unknown = renderMainShellFrame(
      MIN_VIEWPORT,
      buildShellData(state, { ...model, tasks: [unknownTask] }),
      { color: false },
    );

    expect(failed).toContain("✕ ci");
    expect(failed).toContain("Next: fix failing checks.");
    expect(unknown).toContain("? coverage");
    expect(unknown).toContain("Next: refresh unknown checks.");
  });

  test("renders the PTY terminal surface and terminal-mode hint", () => {
    const frame = renderMainShellFrame(
      MIN_VIEWPORT,
      getMockShellData({
        inputMode: "terminal",
        focusedRegion: "center",
        activeTab: "terminal",
        terminal: {
          status: "running",
          rows: [
            { segments: [{ text: "$ pwd" }] },
            { segments: [{ text: "/Users/samhall/conductor/workspaces/craig/boston-v2" }] },
          ],
          error: null,
        },
      }),
      { color: false },
    );

    expect(frame).toContain("TERMINAL  task_20260430_02 · bug-fixes");
    expect(frame).toContain("TERMINAL   ↑↓/PgUp/PgDn scroll");
    expect(frame).toContain("$ pwd");
    expect(frame).toContain("/Users/samhall/conductor/workspaces/");
    expect(frame).not.toContain("terminal ▸ terminal mode");
  });

  test("wraps rendered PTY URLs with terminal hyperlinks", () => {
    const frame = renderMainShellFrame(
      MIN_VIEWPORT,
      getMockShellData({
        inputMode: "terminal",
        focusedRegion: "center",
        activeTab: "terminal",
        terminal: {
          status: "running",
          rows: [
            { segments: [{ text: "Open https://x.io/17." }] },
          ],
          error: null,
        },
      }),
    );

    expect(frame).toContain("\u001B]8;;https://x.io/17\u001B\\https://x.io/17\u001B]8;;\u001B\\.");
  });

  test("renders the attach hint using concrete agent tab ids", () => {
    const task = buildTaskRecord("/tmp/craig", {
      id: "task_20260430_02",
      repoId: "repo_bug_fixes",
      workspaceId: "workspace_bug_fixes",
    });
    const data = buildShellData(
      {
        ...createInitialShellState(null),
        selectedRepoId: "repo_bug_fixes",
        selectedTaskId: task.id,
        selectedLeftItemId: `task:${task.id}`,
        selectedPtyTabId: "task_20260430_02:agent",
        activeTab: "task_20260430_02:agent",
        focusedRegion: "center",
      },
      {
        workspaceRoot: "/tmp/craig",
        repos: [{ id: "repo_bug_fixes", name: "bug-fixes", rootPath: "/tmp/craig", defaultBranch: "main", createdAt: "", updatedAt: "" }],
        tasks: [task],
        inspection: null,
      },
    );

    const frame = renderMainShellFrame(MIN_VIEWPORT, data, { color: false });

    expect(frame).toContain("Press Enter on the AGENT tab");
    expect(frame).not.toContain("Press Enter on the TERMINAL tab");
  });

  test("renders recoverable PTY startup errors", () => {
    const frame = renderMainShellFrame(
      MIN_VIEWPORT,
      getMockShellData({
        activeTab: "terminal",
        terminal: {
          status: "failed",
          rows: [],
          error: "node-pty native module did not load",
        },
      }),
      { color: false },
    );

    expect(frame).toContain("terminal ▸ PTY unavailable");
    expect(frame).toContain("node-pty native module did not load");
    expect(frame).toContain("Fix the native dependency setup");
  });

  test("renders styled terminal emulator rows without breaking panel output", () => {
    const frame = renderMainShellFrame(
      MIN_VIEWPORT,
      getMockShellData({
        inputMode: "terminal",
        focusedRegion: "center",
        activeTab: "terminal",
        terminal: {
          status: "running",
          rows: [{ segments: [{ text: "green", style: { fg: "0dbc79" } }] }],
          error: null,
        },
      }),
      { color: true },
    );

    expect(frame).toContain("green");
    expect(frame).toContain("\u001B[38;2;13;188;121");
    expect(frame).not.toContain("terminal ▸ terminal mode");
    expect(frame).toContain("CONTEXT");
  });

  test("preserves full-width terminal background rows for PTY surfaces", () => {
    const frame = renderMainShellFrame(
      MIN_VIEWPORT,
      getMockShellData({
        inputMode: "terminal",
        focusedRegion: "center",
        activeTab: "agent",
        terminal: {
          status: "running",
          rows: [{ segments: [{ text: "> prompt", style: { fg: "e5e5e5", bg: "2a2a2a" } }] }],
          error: null,
        },
      }),
      { color: true },
    );

    expect(frame).toContain("> prompt");
    expect(frame).toContain("48;2;42;42;42");
  });

  test("renders PTY rows with a small horizontal gutter", () => {
    const frame = renderMainShellFrame(
      MIN_VIEWPORT,
      getMockShellData({
        inputMode: "terminal",
        focusedRegion: "center",
        activeTab: "agent",
        terminal: {
          status: "running",
          rows: [{ segments: [{ text: "gutter check" }] }],
          error: null,
        },
      }),
      { color: false },
    );

    expect(frame).toContain("  gutter check");
    expect(frame).not.toContain("agent ▸ terminal mode");
  });

  test("clips guttered PTY rows to the physical frame width", () => {
    const frame = renderMainShellFrame(
      MIN_VIEWPORT,
      getMockShellData({
        inputMode: "terminal",
        focusedRegion: "center",
        activeTab: "agent",
        terminal: {
          status: "running",
          rows: [{ segments: [{ text: "x".repeat(MIN_VIEWPORT.width) }] }],
          error: null,
        },
      }),
      { color: false },
    );

    expect(frame.split("\n").every((line) => line.length <= MIN_VIEWPORT.width)).toBe(true);
  });

  test("renders PTY rows without reapplying Craig center-pane colors after ANSI resets", () => {
    const frame = renderMainShellFrame(
      MIN_VIEWPORT,
      getMockShellData({
        inputMode: "terminal",
        focusedRegion: "center",
        activeTab: "agent",
        terminal: {
          status: "running",
          rows: [{ segments: [{ text: "codex", style: { fg: "29b8db" } }, { text: " output" }] }],
          error: null,
        },
      }),
      { color: true },
    );

    const promptLine = frame
      .split("\n")
      .find((line) => line.includes("\u001B[38;2;41;184;219;48;2;10;10;10mcodex"));

    expect(promptLine).toBeDefined();
    expect(promptLine).toContain("\u001B[38;2;41;184;219;48;2;10;10;10mcodex");
    expect(promptLine).not.toContain(
      "\u001B[38;2;230;230;230;48;2;10;10;10m\u001B[38;2;41;184;219m",
    );
    expect(promptLine).not.toContain(
      "\u001B[0m\u001B[38;2;230;230;230;48;2;10;10;10m output",
    );
  });
});

function inspectionFixture(input: { selectedFilePath?: string | null; selectedDiffPath?: string | null }): TaskLocalInspection {
  return {
    taskId: "task_20260430_02",
    fileRows: [
      { kind: "directory", path: "src", depth: 0, label: "src" },
      { kind: "file", path: "src/app.ts", depth: 1, label: "app.ts" },
    ],
    filePaths: ["src/app.ts"],
    diffRows: [
      { group: "staged", path: "README.md", status: "M", additions: 1, deletions: 0 },
      { group: "unstaged", path: "src/app.ts", status: "M", additions: 2, deletions: 1 },
    ],
    diffPaths: ["README.md", "src/app.ts"],
    diffContents: {
      "README.md": {
        path: "README.md",
        status: "ready",
        title: "README.md",
        lines: [
          "staged",
          "diff --git a/README.md b/README.md",
          "@@ -1 +1 @@",
          "+after staged",
        ],
        byteLength: 60,
      },
      "src/app.ts": {
        path: "src/app.ts",
        status: "ready",
        title: "src/app.ts",
        lines: [
          "unstaged",
          "diff --git a/src/app.ts b/src/app.ts",
          "@@ -1,2 +1,2 @@",
          "-export const app = false;",
          "+export const app = true;",
          " // after unstaged",
          " export function run() {",
          "   return app;",
          " }",
        ],
        byteLength: 80,
      },
    },
    selectedFilePath: input.selectedFilePath ?? null,
    selectedDiffPath: input.selectedDiffPath ?? null,
    selectedFile: {
      path: input.selectedFilePath ?? null,
      status: "ready",
      title: input.selectedFilePath ?? "No file selected",
      lines: [
        "export const app = true;",
        "const label = \"Craig\";",
        "export function run() {",
        "  return label;",
        "}",
      ],
      byteLength: 24,
    },
    selectedDiff: {
      path: input.selectedDiffPath ?? null,
      status: "ready",
      title: input.selectedDiffPath ?? "No diff selected",
      lines: [
        "unstaged",
        "diff --git a/src/app.ts b/src/app.ts",
        "@@ -1,2 +1,2 @@",
        "-export const app = false;",
        "+export const app = true;",
        " // after unstaged",
        " export function run() {",
        "   return app;",
        " }",
      ],
      byteLength: 80,
    },
    error: null,
  };
}
