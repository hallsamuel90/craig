import { describe, expect, test } from "vitest";

import type { TaskLocalInspection } from "../src/ui/shell/task-local-inspection.js";
import type { ProjectTaskRepoTarget } from "../src/domain/task/index.js";
import { getMockShellData } from "../src/ui/mock-data.js";
import { MIN_VIEWPORT } from "../src/ui/layout.js";
import { OPTIONS_MENU_ITEMS } from "../src/ui/options.js";
import { renderBootOverlayFrame, renderErrorLogOverlayFrame, renderMainShellFrame, renderOptionsOverlayFrame, renderPauseOverlayFrame } from "../src/ui/render.js";
import { createInitialShellState } from "../src/ui/state.js";
import { buildShellData } from "../src/ui/shell/data.js";
import { buildTaskRecord } from "./test-helpers.js";

function contentCenter(line: string): number {
  const first = line.search(/\S/);
  const last = line.search(/\s*$/) - 1;
  return (first + last) / 2;
}

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

    expect(frame).toContain("Control mode is paused.");
    expect(frame).toContain("> Resume");
    expect(frame).toContain("  Options");
    expect(frame).toContain("  Exit");
  });

  test("renders error log overlay entries", () => {
    const frame = renderErrorLogOverlayFrame(MIN_VIEWPORT, {
      color: false,
      errorLogPath: "/tmp/craig/.craig/logs/errors.log",
      errorLogLines: ["[2026-06-09T00:00:00.000Z] refresh PR checks", "message: gh auth failed"],
    });

    expect(frame).toContain("Error Log");
    expect(frame).toContain("/tmp/craig/.craig/logs/errors.log");
    expect(frame).toContain("refresh PR checks");
    expect(frame).toContain("message: gh auth failed");
    expect(frame).toContain("Esc returns to Options.");
  });

  test("renders empty error log overlay state", () => {
    const frame = renderErrorLogOverlayFrame(MIN_VIEWPORT, {
      color: false,
      errorLogPath: "/tmp/craig/.craig/logs/errors.log",
      errorLogLines: [],
    });

    expect(frame).toContain("No Craig errors have been logged.");
  });

  test("renders options overlay with error log entry", () => {
    const frame = renderOptionsOverlayFrame(MIN_VIEWPORT, {
      color: false,
      optionsMenuItems: OPTIONS_MENU_ITEMS,
      menuIndex: 2,
    });

    expect(frame).toContain("  Runners");
    expect(frame).toContain("  Feature Previews");
    expect(frame).toContain("> Error Log");
    expect(frame).toContain("  Help");
  });

  test("keeps overlays vertically anchored from boot through feature previews", () => {
    const bootFrame = renderBootOverlayFrame(MIN_VIEWPORT, {
      color: false,
      menuIndex: 0,
    });
    const optionsFrame = renderOptionsOverlayFrame(MIN_VIEWPORT, {
      color: false,
      optionsMenuItems: OPTIONS_MENU_ITEMS,
      menuIndex: 0,
    });
    const previewsFrame = renderOptionsOverlayFrame(MIN_VIEWPORT, {
      color: false,
      optionsMenuItems: ["[ ] Incremental center pane"],
      optionsMessage: "Experimental features may change or be removed. Enter toggles.",
      optionsSubtitle: "Feature Previews - Experimental",
      menuIndex: 0,
    });
    const bootLines = bootFrame.split("\n");
    const optionsLines = optionsFrame.split("\n");
    const previewLines = previewsFrame.split("\n");

    expect(bootLines.findIndex((line) => line.includes("crAIg is that you?"))).toBe(
      optionsLines.findIndex((line) => line.includes("Configuration")),
    );
    expect(optionsLines.findIndex((line) => line.includes("Configuration"))).toBe(
      previewLines.findIndex((line) => line.includes("Feature Previews - Experimental")),
    );
    expect(bootLines.findIndex((line) => line.includes("Start"))).toBe(
      optionsLines.findIndex((line) => line.includes("Runners")),
    );
    expect(optionsLines.findIndex((line) => line.includes("Runners"))).toBe(
      previewLines.findIndex((line) => line.includes("Incremental center pane")),
    );
    expect(contentCenter(bootLines.find((line) => line.includes("> Start")) ?? "")).toBeCloseTo(
      contentCenter(optionsLines.find((line) => line.includes("> Runners")) ?? ""),
      0,
    );
    expect(contentCenter(optionsLines.find((line) => line.includes("> Runners")) ?? "")).toBeCloseTo(
      contentCenter(previewLines.find((line) => line.includes("> [ ] Incremental center pane")) ?? ""),
      0,
    );
  });

  test("renders the three-column mock workspace shell", () => {
    const frame = renderMainShellFrame(MIN_VIEWPORT, getMockShellData(), { color: false });

    expect(frame).toContain("CRAIG");
    expect(frame).toContain("~/workspaces/craig/colombo");
    expect(frame).toContain("CRAIG  |  ~/workspaces/craig/colombo  |  codex");
    expect(frame).not.toContain("4 tasks");
    expect(frame).not.toContain("v0.1.0");
    expect(frame).not.toContain("task/interactive-shell  |");
    expect(frame).toContain("WORKSPACES");
    expect(frame).toContain("+ New Task");
    expect(frame).toContain("+ New Workspace");
    expect(frame).toContain("codex");
    expect(frame).toContain("n new task");
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

  test("keeps the center tab rule scoped to the active tab in control mode", () => {
    const frame = renderMainShellFrame(MIN_VIEWPORT, getMockShellData(), { color: false, centerOnly: true });
    const underline = frame.split("\n")[2] ?? "";

    expect(underline).toBe("  ──────".padEnd(MIN_VIEWPORT.width));
  });

  test("extends the center tab rule across the full center content width when engaged", () => {
    const frame = renderMainShellFrame(
      MIN_VIEWPORT,
      getMockShellData({ inputMode: "terminal" }),
      { color: false, centerOnly: true },
    );
    const underline = frame.split("\n")[2] ?? "";

    expect(underline).toBe(`  ${"─".repeat(MIN_VIEWPORT.width - 2)}`);
  });

  test("renders the terminal engaged indicator text in green", () => {
    const frame = renderMainShellFrame(
      MIN_VIEWPORT,
      getMockShellData({ inputMode: "terminal" }),
      { color: true, centerOnly: true },
    );
    const successOnPanel = "\u001B[38;2;158;206;106;48;2;10;10;10m";
    const mutedOnPanel = "\u001B[38;2;86;95;137;48;2;10;10;10m";

    expect(frame).toContain(`${successOnPanel} engaged `);
    expect(frame).not.toContain(`${mutedOnPanel} engaged `);
  });

  test("renders footer toast feedback without replacing shortcut text", () => {
    const frame = renderMainShellFrame(
      MIN_VIEWPORT,
      getMockShellData({ footerToast: { tone: "success", message: "Refreshed checks: 2 reported" } }),
      { color: false },
    );
    const footer = frame.split("\n").at(-1) ?? "";

    expect(footer).toContain("n new task");
    expect(footer).toContain("✓ Refreshed checks: 2 reported");
    expect(footer.trimEnd().endsWith("✓ Refreshed checks: 2 reported")).toBe(true);
  });

  test("renders footer error toast feedback", () => {
    const frame = renderMainShellFrame(
      MIN_VIEWPORT,
      getMockShellData({ footerToast: { tone: "error", message: "gh auth failed" } }),
      { color: false },
    );
    const footer = frame.split("\n").at(-1) ?? "";

    expect(footer).toContain("n new task");
    expect(footer).toContain("✗ gh auth failed");
    expect(footer.trimEnd().endsWith("✗ gh auth failed")).toBe(true);
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

  test("renders runner identity for tasks and the new-task selector", () => {
    const codexTask = buildTaskRecord("/tmp/craig", {
      id: "task_20260430_02",
      title: "rewrite auth module",
      repoId: "repo_bug_fixes",
      workspaceId: "workspace_bug_fixes",
    });
    const claudeTask = buildTaskRecord("/tmp/craig", {
      id: "task_20260430_03",
      title: "update dashboard layout",
      repoId: "repo_bug_fixes",
      workspaceId: "workspace_bug_fixes",
      runner: "claude",
    });
    const data = buildShellData(
      {
        ...createInitialShellState(null),
        selectedRepoId: "repo_bug_fixes",
        selectedTaskId: codexTask.id,
        selectedLeftItemId: "new-task",
        focusedRegion: "tasks",
        selectedRunner: "claude",
      },
      {
        workspaceRoot: "/tmp/craig",
        repos: [{ id: "repo_bug_fixes", name: "bug-fixes", rootPath: "/tmp/craig", defaultBranch: "main", createdAt: "", updatedAt: "" }],
        tasks: [codexTask, claudeTask],
        inspection: null,
      },
    );

    const frame = renderMainShellFrame(MIN_VIEWPORT, data, { color: false });

    expect(frame).toContain("rewrite auth module");
    expect(frame).toContain("update dashboard layout");
    expect(frame).toContain("+ New Task [Claude]");
    expect(frame).toContain("claude");
  });

  test("renders an actionable empty state when the selected repo has no tasks", () => {
    const repo = { id: "repo_bug_fixes", name: "bug-fixes", rootPath: "/tmp/craig", defaultBranch: "main", createdAt: "", updatedAt: "" };
    const data = buildShellData(
      {
        ...createInitialShellState(null),
        selectedRepoId: repo.id,
        selectedLeftItemId: `repo:${repo.id}`,
        focusedRegion: "center",
        selectedRunner: "claude",
      },
      {
        workspaceRoot: "/tmp/craig",
        repos: [repo],
        tasks: [],
        inspection: null,
      },
    );

    const frame = renderMainShellFrame(MIN_VIEWPORT, data, { color: false });

    expect(data.footerText).toBe("n new task   Tab tasks   Esc pause   ? help");
    expect(data.tabs).toEqual([{ id: "empty", label: "EMPTY", active: true, focused: true }]);
    expect(data.centerTranscript.map((line) => line.text)).toContain("Press n or choose + New Task to create one with Claude.");
    expect(frame).toContain("EMPTY  no task · bug-fixes");
    expect(frame).toContain("No tasks in bug-fixes.");
    expect(frame).toContain("+ New Task [Claude]");
    expect(frame).not.toContain("Enter attach");
    expect(frame).not.toContain("Press Enter on the AGENT");
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
      prs: [{
        provider: "github",
        owner: null,
        repo: null,
        number: 17,
        url: "https://github.com/example/repo/pull/17",
        title: null,
        status: "open",
        draft: false,
        baseBranch: "main",
        headBranch: "craig/task_20260430_02",
        mergeable: true,
        mergeStateStatus: "CLEAN",
        reviewDecision: "REVIEW_REQUIRED",
        requiredChecks: [
          { name: "ci", status: "success", conclusion: "SUCCESS" },
          { name: "docs", status: "skipped", conclusion: "SKIPPED" },
          { name: "e2e", status: "pending", conclusion: null },
        ],
        comments: [
          {
            author: "octocat",
            body: "Please add a regression test for this before merge.",
            createdAt: "2026-05-06T00:01:00.000Z",
            url: "https://github.com/example/repo/pull/17#issuecomment-1",
          },
        ],
        createdAt: null,
        updatedAt: null,
        mergedAt: null,
        lastSyncedAt: "2026-05-06T00:00:00.000Z",
        lastSyncedHeadSha: "abcdef123456",
      }],
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
    expect(frame).toContain("REVIEW   ●");
    expect(frame).toContain("#17");
    expect(frame).toContain("\u001B]8;;https://github.com/example/repo/pull/17\u001B\\  Open in GitHub ↗\u001B]8;;\u001B\\");
    expect(frame).toContain("main → craig/task_20260430_02");
    expect(frame).toContain("merge blocked");
    expect(frame).toContain("review required");
    expect(frame).toContain("✓ ci");
    expect(frame).toContain("○ docs");
    expect(frame).toContain("● e2e");
    expect(frame).toContain("Review comments (1)");
    expect(frame).toContain("octocat ·");
    expect(frame).toContain("Please add a regression test");
    expect(frame).toContain("for this before merge.");
    expect(frame).toContain("R refresh checks");
    expect(frame).toContain("X close task");
    expect(frame).not.toContain("Next:");
    expect(frame).not.toContain("create pr");
    expect(frame).not.toContain("merge pr");

    const colorFrame = renderMainShellFrame(MIN_VIEWPORT, data, { color: true });
    expect(colorFrame).toContain("\u001B[38;2;224;175;104;48;2;10;10;10m●");
  });

  test("renders the newest active PR and preserves previous terminal PR history", () => {
    const task = buildTaskRecord("/tmp/craig", {
      id: "task_20260430_02",
      repoId: "repo_bug_fixes",
      workspaceId: "workspace_bug_fixes",
      prs: [
        {
          provider: "github",
          owner: null,
          repo: null,
          number: 17,
          url: "https://github.com/example/repo/pull/17",
          title: null,
          status: "merged",
          draft: false,
          baseBranch: "main",
          headBranch: "craig/task_20260430_02",
          mergeable: false,
          mergeStateStatus: "UNKNOWN",
          reviewDecision: null,
          requiredChecks: [],
          comments: [],
          createdAt: null,
          updatedAt: null,
          mergedAt: "2026-05-06T00:00:00.000Z",
          lastSyncedAt: "2026-05-06T00:00:00.000Z",
          lastSyncedHeadSha: "oldsha",
        },
        {
          provider: "github",
          owner: null,
          repo: null,
          number: 42,
          url: "https://github.com/example/repo/pull/42",
          title: null,
          status: "open",
          draft: false,
          baseBranch: "main",
          headBranch: "agent/follow-up",
          mergeable: true,
          mergeStateStatus: "CLEAN",
          reviewDecision: null,
          requiredChecks: [],
          comments: [],
          createdAt: null,
          updatedAt: null,
          mergedAt: null,
          lastSyncedAt: "2026-05-06T01:00:00.000Z",
          lastSyncedHeadSha: "newsha",
        },
      ],
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

    expect(frame).toContain("#42");
    expect(frame).toContain("main → agent/follow-up");
    expect(frame).toContain("+ 1 previous PR");
  });

  test("renders review guidance for failed and unknown checks", () => {
    const baseTask = buildTaskRecord("/tmp/craig", {
      id: "task_20260430_02",
      repoId: "repo_bug_fixes",
      workspaceId: "workspace_bug_fixes",
      prs: [{
        provider: "github",
        owner: null,
        repo: null,
        number: 17,
        url: "https://github.com/example/repo/pull/17",
        title: null,
        status: "open",
        draft: false,
        baseBranch: "main",
        headBranch: "craig/task_20260430_02",
        mergeable: true,
        mergeStateStatus: "CLEAN",
        requiredChecks: [{ name: "ci", status: "failed", conclusion: "FAILURE" }],
        createdAt: null,
        updatedAt: null,
        mergedAt: null,
        lastSyncedAt: "2026-05-06T00:00:00.000Z",
        lastSyncedHeadSha: "abcdef123456",
      }],
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
      prs: [{
        ...baseTask.prs[0]!,
        requiredChecks: [{ name: "coverage", status: "unknown" as const, conclusion: null }],
      }],
    };
    const unknown = renderMainShellFrame(
      MIN_VIEWPORT,
      buildShellData(state, { ...model, tasks: [unknownTask] }),
      { color: false },
    );

    expect(failed).toContain("✕ ci");
    expect(unknown).toContain("? coverage");
    expect(failed).not.toContain("Next:");
    expect(unknown).not.toContain("Next:");
  });

  test("renders distinct review header icons for missing, draft, merged, and closed PR states", () => {
    const baseTask = buildTaskRecord("/tmp/craig", {
      id: "task_20260430_02",
      repoId: "repo_bug_fixes",
      workspaceId: "workspace_bug_fixes",
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
    const renderTask = (task: typeof baseTask) => renderMainShellFrame(
      MIN_VIEWPORT,
      buildShellData(state, { ...model, tasks: [task] }),
      { color: false },
    );
    const renderTaskWithColor = (task: typeof baseTask) => renderMainShellFrame(
      MIN_VIEWPORT,
      buildShellData(state, { ...model, tasks: [task] }),
      { color: true },
    );

    const draftTask = {
      ...baseTask,
      prs: [{
        provider: "github" as const,
        owner: null,
        repo: null,
        number: 17,
        url: "https://github.com/example/repo/pull/17",
        title: null,
        status: "draft" as const,
        draft: true,
        baseBranch: null,
        headBranch: null,
        mergeable: false,
        mergeStateStatus: null,
        requiredChecks: [],
        createdAt: null,
        updatedAt: null,
        mergedAt: null,
        lastSyncedAt: null,
        lastSyncedHeadSha: null,
      }],
    };
    const mergedTask = {
      ...draftTask,
      prs: [{ ...draftTask.prs[0]!, status: "merged" as const, draft: false }],
    };
    const closedTask = {
      ...draftTask,
      prs: [{
        ...draftTask.prs[0]!,
        number: 18,
        status: "closed" as const,
        draft: false,
        mergeable: true,
        requiredChecks: [{ name: "ci", status: "success" as const, conclusion: "SUCCESS" }],
      }],
    };

    expect(renderTask(baseTask)).toContain("REVIEW  ○ ○");
    expect(renderTask(draftTask)).toContain("REVIEW   ○");
    expect(renderTask(mergedTask)).toContain("REVIEW   ✓");
    expect(renderTask(closedTask)).toContain("REVIEW   ○");
    expect(renderTaskWithColor(draftTask)).toContain("\u001B[38;2;86;95;137;48;2;10;10;10m");
    expect(renderTaskWithColor(closedTask)).toContain("\u001B[38;2;247;118;142;48;2;10;10;10m");
  });

  test("colors approved review text green in the merge status row", () => {
    const task = buildTaskRecord("/tmp/craig", {
      id: "task_20260430_02",
      repoId: "repo_bug_fixes",
      workspaceId: "workspace_bug_fixes",
      prs: [{
        provider: "github" as const,
        owner: null,
        repo: null,
        number: 17,
        url: "https://github.com/example/repo/pull/17",
        title: null,
        status: "open" as const,
        draft: false,
        baseBranch: "main",
        headBranch: "craig/task_20260430_02",
        mergeable: true,
        mergeStateStatus: "CLEAN",
        reviewDecision: "APPROVED",
        requiredChecks: [{ name: "ci", status: "success" as const, conclusion: "SUCCESS" }],
        createdAt: null,
        updatedAt: null,
        mergedAt: null,
        lastSyncedAt: null,
        lastSyncedHeadSha: null,
      }],
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

    const frame = renderMainShellFrame(MIN_VIEWPORT, data, { color: true });

    expect(frame).toContain("merge ready · ");
    expect(frame).toContain("\u001B[38;2;158;206;106;48;2;10;10;10mreview approved");
  });

  test("keeps the PR readiness badge pending while CI is still running before surfacing required review as blocked", () => {
    const baseTask = buildTaskRecord("/tmp/craig", {
      id: "task_20260430_02",
      repoId: "repo_bug_fixes",
      status: "pr_open",
      prs: [{
        provider: "github" as const,
        owner: null,
        repo: null,
        number: 17,
        url: "https://github.com/example/repo/pull/17",
        title: null,
        status: "open" as const,
        draft: false,
        baseBranch: null,
        headBranch: null,
        mergeable: true,
        mergeStateStatus: "REVIEW_REQUIRED",
        reviewDecision: "REVIEW_REQUIRED",
        requiredChecks: [{ name: "ci", status: "pending" as const, conclusion: null }],
        createdAt: null,
        updatedAt: null,
        mergedAt: null,
        lastSyncedAt: null,
        lastSyncedHeadSha: null,
      }],
    });
    const state = {
      ...createInitialShellState(null),
      selectedRepoId: "repo_bug_fixes",
      selectedTaskId: baseTask.id,
      selectedLeftItemId: `task:${baseTask.id}`,
      focusedRegion: "inspector" as const,
      inspectionMode: "review" as const,
    };
    const model = {
      workspaceRoot: "/tmp/craig",
      repos: [{ id: "repo_bug_fixes", name: "bug-fixes", rootPath: "/tmp/craig", defaultBranch: "main", createdAt: "", updatedAt: "" }],
      tasks: [baseTask],
      inspection: null,
    };
    const renderTask = (task: typeof baseTask) => renderMainShellFrame(
      MIN_VIEWPORT,
      buildShellData(state, { ...model, tasks: [task] }),
      { color: false },
    );

    const checksRunning = renderTask(baseTask);
    const checksPassed = renderTask({
      ...baseTask,
      prs: [{ ...baseTask.prs[0]!, requiredChecks: [{ name: "ci", status: "success" as const, conclusion: "SUCCESS" }] }],
    });

    expect(checksRunning).toContain("REVIEW   ●");
    expect(checksPassed).toContain("REVIEW   ✕");
  });

  test("renders all headers when navigating to review panel on a new single-repo task with no PTY tabs", () => {
    const task = buildTaskRecord("/tmp/craig", {
      id: "task_20260430_02",
      repoId: "repo_bug_fixes",
      workspaceId: "ws_bug_fixes",
      ptyTabs: [],
    });
    const workspace = {
      id: "ws_bug_fixes",
      kind: "repo" as const,
      name: "bug-fixes",
      primaryRepoId: "repo_bug_fixes",
      branch: "main",
      status: "active" as const,
      linkedRepoIds: [],
      archivedAt: null,
      createdAt: "",
      updatedAt: "",
    };
    const model = {
      workspaceRoot: "/tmp/craig",
      workspaces: [workspace],
      repos: [{ id: "repo_bug_fixes", name: "bug-fixes", rootPath: "/tmp/craig", defaultBranch: "main", createdAt: "", updatedAt: "" }],
      tasks: [task],
      inspection: null,
    };
    const state = {
      ...createInitialShellState(null),
      selectedWorkspaceId: "ws_bug_fixes",
      selectedTaskId: task.id,
      selectedLeftItemId: `task:${task.id}`,
      focusedRegion: "inspector" as const,
      inspectionMode: "review" as const,
    };

    const frame = renderMainShellFrame(MIN_VIEWPORT, buildShellData(state, model), { color: false });

    expect(frame).toContain("CRAIG  |");
    expect(frame).toContain("WORKSPACES");
    expect(frame).toContain("CHANGES  FILES  REVIEW");
    expect(frame).toContain("craig/task_20260430_02");
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
            { segments: [{ text: "/home/developer/workspaces/craig/boston-v2" }] },
          ],
          error: null,
        },
      }),
      { color: false },
    );

    expect(frame).toContain("TERMINAL  task_20260430_02 · bug-fixes");
    expect(frame).toContain("TERMINAL   ↑↓/PgUp/PgDn scroll   Ctrl+] return to control");
    expect(frame).toContain("$ pwd");
    expect(frame).toContain("/home/developer/workspaces/");
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

  test("renders runner-specific agent tab ids as attached PTY surfaces", () => {
    const task = buildTaskRecord("/tmp/craig", {
      id: "task_20260430_02",
      repoId: "repo_bug_fixes",
      workspaceId: "workspace_bug_fixes",
      ptyTabs: [{
        id: "task_20260430_02:cursor",
        kind: "agent",
        runner: "cursor",
        title: "Cursor",
        command: ["cursor-agent"],
        createdAt: "2026-05-04T00:00:00.000Z",
        updatedAt: "2026-05-04T00:00:00.000Z",
      }],
      selectedPtyTabId: "task_20260430_02:cursor",
    });
    const data = buildShellData(
      {
        ...createInitialShellState(null),
        inputMode: "terminal",
        selectedRepoId: "repo_bug_fixes",
        selectedTaskId: task.id,
        selectedLeftItemId: `task:${task.id}`,
        selectedPtyTabId: "task_20260430_02:cursor",
        activeTab: "task_20260430_02:cursor",
        focusedRegion: "center",
        terminal: {
          status: "running",
          rows: [{ segments: [{ text: "cursor session attached" }] }],
          error: null,
        },
      },
      {
        workspaceRoot: "/tmp/craig",
        repos: [{ id: "repo_bug_fixes", name: "bug-fixes", rootPath: "/tmp/craig", defaultBranch: "main", createdAt: "", updatedAt: "" }],
        tasks: [task],
        inspection: null,
      },
    );

    const frame = renderMainShellFrame(MIN_VIEWPORT, data, { color: false });

    expect(frame).toContain("cursor session attached");
    expect(frame).not.toContain("Press Enter to attach this PTY-backed agent session.");
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
          rows: [{ segments: [{ text: "> prompt", style: { fg: "e5e5e5", bg: "2a2a2a" } }, { text: " " }] }],
          error: null,
        },
      }),
      { color: true },
    );

    const promptLine = frame.split("\n").find((line) => line.includes("> prompt"));
    expect(frame).toContain("> prompt");
    expect(promptLine).toBeDefined();
    expect(promptLine!).toContain("48;2;42;42;42m ");
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

  test("clips wide PTY rows to the physical frame width", () => {
    const frame = renderMainShellFrame(
      MIN_VIEWPORT,
      getMockShellData({
        inputMode: "terminal",
        focusedRegion: "center",
        activeTab: "agent",
        terminal: {
          status: "running",
          rows: [{ segments: [{ text: "Trust this workspace? " + "界".repeat(MIN_VIEWPORT.width) }] }],
          error: null,
        },
      }),
      { color: false },
    );

    expect(frame.split("\n").every((line) => displayWidth(line) <= MIN_VIEWPORT.width)).toBe(true);
    expect(frame.split("\n")[0]).toContain("CRAIG");
  });

  test("renders project workspace left panel with icon, task rows, and repo summary", () => {
    const task = buildTaskRecord("/tmp/craig", {
      id: "task_proj_01",
      title: "scaffold api",
      type: "project",
      repoId: "repo_projects",
      workspaceId: "ws_projects",
    });
    const workspace = {
      id: "ws_projects",
      kind: "project" as const,
      name: "projects",
      primaryRepoId: "repo_projects",
      rootPath: "/tmp/projects",
      discoveredRepoIds: ["repo_alpha", "repo_beta", "repo_gamma"],
      branch: "project",
      status: "active" as const,
      linkedRepoIds: ["repo_alpha", "repo_beta", "repo_gamma"],
      archivedAt: null,
      createdAt: "",
      updatedAt: "",
    };
    const data = buildShellData(
      {
        ...createInitialShellState(null),
        selectedWorkspaceId: "ws_projects",
        selectedTaskId: task.id,
        selectedLeftItemId: `task:${task.id}`,
        focusedRegion: "tasks",
      },
      {
        workspaceRoot: "/tmp/projects",
        workspaces: [workspace],
        repos: [
          { id: "repo_alpha", name: "alpha", rootPath: "/tmp/projects/alpha", defaultBranch: "main", createdAt: "", updatedAt: "" },
          { id: "repo_beta", name: "beta", rootPath: "/tmp/projects/beta", defaultBranch: "main", createdAt: "", updatedAt: "" },
          { id: "repo_gamma", name: "gamma", rootPath: "/tmp/projects/gamma", defaultBranch: "main", createdAt: "", updatedAt: "" },
        ],
        tasks: [task],
        inspection: null,
      },
    );

    const frame = renderMainShellFrame(MIN_VIEWPORT, data, { color: false });

    expect(frame).toContain("WORKSPACES");
    expect(frame).toContain("≡ projects");
    expect(frame).toContain("scaffold api");
    expect(frame).toContain("Repos (3)");
    expect(frame).toContain("· alpha");
    expect(frame).toContain("· beta");
    expect(frame).toContain("+ New Project Task");
    expect(frame).not.toContain("+ New Task");
  });

  test("renders project task review panel with per-repo target rows", () => {
    const makeTarget = (repoId: string, status: "ready" | "unavailable"): ProjectTaskRepoTarget => ({
      repoId,
      branch: `craig/proj_01/${repoId}`,
      repoRoot: `/tmp/projects/${repoId}`,
      worktreePath: `/tmp/craig/.craig/worktrees/proj_01/${repoId}`,
      status,
      failureReason: status === "unavailable" ? "checkout failed" : null,
      checks: { source: { type: "repo_config", path: ".craig/config.json" }, lastRunAt: null, status: "not_run", commands: [], results: [] },
      lastCommit: null,
      pullRequest: {
        provider: "github",
        number: repoId === "repo_alpha" ? 12 : null,
        url: repoId === "repo_alpha" ? "https://github.com/example/alpha/pull/12" : null,
        baseBranch: null,
        headBranch: null,
        status: repoId === "repo_alpha" ? "open" : null,
        mergeable: repoId === "repo_alpha",
        mergeStateStatus: null,
        requiredChecks: repoId === "repo_alpha" ? [{ name: "ci", status: "success", conclusion: "SUCCESS" }] : [],
        lastSyncedAt: repoId === "repo_alpha" ? "2026-05-04T00:00:00.000Z" : null,
        lastSyncedHeadSha: null,
      },
      cleanup: { paneClosedAt: null, worktreeRemovedAt: null, preservedWorktree: false, warning: null },
    });
    const task = buildTaskRecord("/tmp/projects", {
      id: "task_proj_01",
      title: "scaffold api",
      type: "project",
      repoId: "repo_projects",
      workspaceId: "ws_projects",
      repoTargets: [makeTarget("repo_alpha", "ready"), makeTarget("repo_beta", "unavailable")],
    });
    const workspace = {
      id: "ws_projects",
      kind: "project" as const,
      name: "projects",
      primaryRepoId: "repo_projects",
      rootPath: "/tmp/projects",
      discoveredRepoIds: ["repo_alpha", "repo_beta"],
      branch: "project",
      status: "active" as const,
      linkedRepoIds: ["repo_alpha", "repo_beta"],
      archivedAt: null,
      createdAt: "",
      updatedAt: "",
    };
    const data = buildShellData(
      {
        ...createInitialShellState(null),
        selectedWorkspaceId: "ws_projects",
        selectedTaskId: task.id,
        selectedLeftItemId: `task:${task.id}`,
        focusedRegion: "inspector",
        inspectionMode: "review",
      },
      {
        workspaceRoot: "/tmp/projects",
        workspaces: [workspace],
        repos: [
          { id: "repo_alpha", name: "alpha", rootPath: "/tmp/projects/alpha", defaultBranch: "main", createdAt: "", updatedAt: "" },
          { id: "repo_beta", name: "beta", rootPath: "/tmp/projects/beta", defaultBranch: "main", createdAt: "", updatedAt: "" },
        ],
        tasks: [task],
        inspection: null,
      },
    );

    const frame = renderMainShellFrame(MIN_VIEWPORT, data, { color: false });
    const taskRow = data.leftTree.find((row) => row.taskId === "task_proj_01");
    const modeRow = data.rightInspection?.rows.find((row) => row.id === "inspection-mode");

    expect(frame).toContain("CHANGES  FILES  REVIEW");
    expect(frame).toContain("alpha");
    expect(frame).toContain("beta");
    expect(frame).toContain("#12");
    expect(frame).toContain("✓ ci");
    expect(frame).toContain("checkout faile");
    expect(taskRow?.prBadge?.map((segment) => segment.text).join("")).toContain("✓");
    expect(modeRow?.segments?.map((segment) => segment.text).join("")).toContain("✓");
    expect(frame).not.toContain("P create pr");
    expect(frame).not.toContain("M merge");
  });

  test("keeps project review rollups green for merged child PRs with stale review metadata", () => {
    const makeMergedTarget = (repoId: string, number: number): ProjectTaskRepoTarget => ({
      repoId,
      branch: `craig/proj_01/${repoId}`,
      repoRoot: `/tmp/projects/${repoId}`,
      worktreePath: `/tmp/craig/.craig/worktrees/proj_01/${repoId}`,
      status: "ready",
      failureReason: null,
      checks: { source: { type: "repo_config", path: ".craig/config.json" }, lastRunAt: null, status: "not_run", commands: [], results: [] },
      lastCommit: null,
      pullRequest: {
        provider: "github",
        number,
        url: `https://github.com/example/${repoId}/pull/${number}`,
        baseBranch: null,
        headBranch: null,
        status: "merged",
        mergeable: false,
        mergeStateStatus: "REVIEW_REQUIRED",
        reviewDecision: "REVIEW_REQUIRED",
        requiredChecks: [{ name: "ci", status: "success", conclusion: "SUCCESS" }],
        lastSyncedAt: "2026-05-04T00:00:00.000Z",
        lastSyncedHeadSha: null,
      },
      cleanup: { paneClosedAt: null, worktreeRemovedAt: null, preservedWorktree: false, warning: null },
    });
    const task = buildTaskRecord("/tmp/projects", {
      id: "task_proj_01",
      title: "scaffold api",
      type: "project",
      repoId: "repo_projects",
      workspaceId: "ws_projects",
      repoTargets: [makeMergedTarget("repo_alpha", 12), makeMergedTarget("repo_beta", 13)],
    });
    const workspace = {
      id: "ws_projects",
      kind: "project" as const,
      name: "projects",
      primaryRepoId: "repo_projects",
      rootPath: "/tmp/projects",
      discoveredRepoIds: ["repo_alpha", "repo_beta"],
      branch: "project",
      status: "active" as const,
      linkedRepoIds: ["repo_alpha", "repo_beta"],
      archivedAt: null,
      createdAt: "",
      updatedAt: "",
    };
    const data = buildShellData(
      {
        ...createInitialShellState(null),
        selectedWorkspaceId: "ws_projects",
        selectedTaskId: task.id,
        selectedLeftItemId: `task:${task.id}`,
        focusedRegion: "inspector",
        inspectionMode: "review",
      },
      {
        workspaceRoot: "/tmp/projects",
        workspaces: [workspace],
        repos: [
          { id: "repo_alpha", name: "alpha", rootPath: "/tmp/projects/alpha", defaultBranch: "main", createdAt: "", updatedAt: "" },
          { id: "repo_beta", name: "beta", rootPath: "/tmp/projects/beta", defaultBranch: "main", createdAt: "", updatedAt: "" },
        ],
        tasks: [task],
        inspection: null,
      },
    );

    const frame = renderMainShellFrame(MIN_VIEWPORT, data, { color: false });
    const taskRow = data.leftTree.find((row) => row.taskId === "task_proj_01");
    const modeRow = data.rightInspection?.rows.find((row) => row.id === "inspection-mode");

    expect(taskRow?.prBadge?.map((segment) => segment.text).join("")).toContain(" ✓");
    expect(modeRow?.segments?.map((segment) => segment.text).join("")).toContain(" ✓");
    expect(frame).toContain("alpha");
    expect(frame).toContain(" ✓");
    expect(frame).not.toContain(" ●");
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

function displayWidth(value: string): number {
  let width = 0;
  for (const character of Array.from(value)) {
    width += characterWidth(character);
  }

  return width;
}

function characterWidth(character: string): number {
  const codePoint = character.codePointAt(0);
  if (codePoint === undefined) {
    return 0;
  }

  if (codePoint === 0 || codePoint < 32 || (codePoint >= 0x7f && codePoint < 0xa0)) {
    return 0;
  }

  if (
    (codePoint >= 0x0300 && codePoint <= 0x036f) ||
    (codePoint >= 0x1ab0 && codePoint <= 0x1aff) ||
    (codePoint >= 0x1dc0 && codePoint <= 0x1dff) ||
    (codePoint >= 0x20d0 && codePoint <= 0x20ff) ||
    (codePoint >= 0xfe00 && codePoint <= 0xfe0f)
  ) {
    return 0;
  }

  if (
    codePoint >= 0x1100 && (
      codePoint <= 0x115f ||
      codePoint === 0x2329 ||
      codePoint === 0x232a ||
      (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) ||
      (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
      (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
      (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
      (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
      (codePoint >= 0xff00 && codePoint <= 0xff60) ||
      (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
      (codePoint >= 0x1f300 && codePoint <= 0x1faff) ||
      (codePoint >= 0x20000 && codePoint <= 0x3fffd)
    )
  ) {
    return 2;
  }

  return 1;
}

describe("file search in inspection panel", () => {
  const task = buildTaskRecord("/tmp/craig", {
    id: "task_20260430_02",
    repoId: "repo_bug_fixes",
    workspaceId: "workspace_bug_fixes",
  });
  const model = {
    workspaceRoot: "/tmp/craig",
    repos: [{ id: "repo_bug_fixes", name: "bug-fixes", rootPath: "/tmp/craig", defaultBranch: "main", createdAt: "", updatedAt: "" }],
    tasks: [task],
    inspection: inspectionFixture({}),
  };
  const baseState = {
    ...createInitialShellState(null),
    selectedRepoId: "repo_bug_fixes",
    selectedTaskId: task.id,
    selectedLeftItemId: `task:${task.id}`,
    activeTab: "inspection" as const,
    inspectionMode: "files" as const,
    focusedRegion: "inspector" as const,
  };

  test("footer shows / search hint when search is inactive", () => {
    const data = buildShellData(baseState, model);
    expect(data.footerText).toContain("/ search");
  });

  test("footer shows active query when search is active", () => {
    const data = buildShellData({ ...baseState, fileSearchQuery: "app" }, model);
    expect(data.footerText).toContain("Search: app");
    expect(data.footerText).not.toContain("/ search");
  });

  test("file tree rows are filtered by active query", () => {
    const data = buildShellData({ ...baseState, fileSearchQuery: "app" }, model);
    const inspectionRows = data.rightInspection?.rows ?? [];
    const fileRows = inspectionRows.filter((r) => r.id !== "file-search" && !r.id.startsWith("mode-"));
    expect(fileRows.some((r) => r.id === "src/app.ts")).toBe(true);
    expect(fileRows.some((r) => r.id === "src")).toBe(false);
  });

  test("non-matching files are hidden when query is active", () => {
    const data = buildShellData({ ...baseState, fileSearchQuery: "README" }, model);
    const inspectionRows = data.rightInspection?.rows ?? [];
    expect(inspectionRows.some((r) => r.id === "src/app.ts")).toBe(false);
  });

  test("search header row appears when query is active", () => {
    const data = buildShellData({ ...baseState, fileSearchQuery: "src" }, model);
    const inspectionRows = data.rightInspection?.rows ?? [];
    expect(inspectionRows.some((r) => r.id === "file-search")).toBe(true);
  });

  test("no search header row when query is null", () => {
    const data = buildShellData(baseState, model);
    const inspectionRows = data.rightInspection?.rows ?? [];
    expect(inspectionRows.some((r) => r.id === "file-search")).toBe(false);
  });
});

describe("workspace browser search", () => {
  const browserEntries = [
    { name: "projects", path: "/home/user/projects", kind: "directory" as const },
    { name: "craig", path: "/home/user/craig", kind: "repo" as const },
    { name: "dotfiles", path: "/home/user/dotfiles", kind: "repo" as const },
  ];

  test("center transcript shows query line when browser search is active", () => {
    const state = {
      ...createInitialShellState(null),
      workspaceBrowser: { cwd: "/home/user", entries: browserEntries, selectedIndex: 0, query: "dot", error: null },
    };
    const data = buildShellData(state, { workspaceRoot: "/home/user", repos: [], tasks: [], inspection: null });
    const transcript = data.centerTranscript.map((l) => l.text).join("\n");
    expect(transcript).toContain("Search: dot");
  });

  test("center transcript shows only filtered entries when search is active", () => {
    const state = {
      ...createInitialShellState(null),
      workspaceBrowser: { cwd: "/home/user", entries: browserEntries, selectedIndex: 0, query: "dot", error: null },
    };
    const data = buildShellData(state, { workspaceRoot: "/home/user", repos: [], tasks: [], inspection: null });
    const transcript = data.centerTranscript.map((l) => l.text).join("\n");
    expect(transcript).toContain("dotfiles");
    expect(transcript).not.toContain("craig");
    expect(transcript).not.toContain("projects");
  });

  test("footer shows active query when browser search is active", () => {
    const state = {
      ...createInitialShellState(null),
      workspaceBrowser: { cwd: "/home/user", entries: browserEntries, selectedIndex: 0, query: "cr", error: null },
    };
    const data = buildShellData(state, { workspaceRoot: "/home/user", repos: [], tasks: [], inspection: null });
    expect(data.footerText).toContain("Search: cr");
  });

  test("footer shows / search hint when browser search is inactive", () => {
    const state = {
      ...createInitialShellState(null),
      workspaceBrowser: { cwd: "/home/user", entries: browserEntries, selectedIndex: 0, query: null, error: null },
    };
    const data = buildShellData(state, { workspaceRoot: "/home/user", repos: [], tasks: [], inspection: null });
    expect(data.footerText).toContain("/ search");
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
