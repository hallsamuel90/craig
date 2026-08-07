import { describe, it, expect } from "vitest";
import {
  getTaskPrimaryPr,
  isPrTerminal,
  upsertTaskPr,
  deriveTaskStatusFromPrs,
  isMergeReady,
  normalizePr,
  summarizeRequiredChecks,
} from "./state.js";
import type { TaskPR, TaskRecord } from "../types.js";

const makePr = (overrides: Partial<TaskPR> = {}): TaskPR => ({
  provider: "github",
  owner: null,
  repo: null,
  number: 1,
  url: "https://github.com/owner/repo/pull/1",
  title: "Test PR",
  status: "open",
  draft: false,
  baseBranch: "main",
  headBranch: "craig/task_01",
  mergeable: true,
  mergeStateStatus: "CLEAN",
  reviewDecision: null,
  requiredChecks: [],
  comments: [],
  createdAt: null,
  updatedAt: null,
  mergedAt: null,
  lastSyncedAt: null,
  lastSyncedHeadSha: null,
  ...overrides,
});

const makeTaskWithPrs = (prs: TaskPR[]): TaskRecord => ({
  id: "task_20240101_01",
  title: "Test",
  slug: "test",
  type: "repo",
  status: "checked",
  runner: "codex",
  repoId: "repo_1",
  workspaceId: "ws_1",
  sessionId: null,
  selectedPtyTabId: null,
  linkedRepoIds: [],
  parentTaskId: null,
  rootTaskId: "task_20240101_01",
  delegationDepth: 0,
  delegationIdempotencyKey: null,
  swarmRunId: null,
  swarmStepId: null,
  repoRoot: "/repo",
  worktreePath: "/worktree",
  branch: "craig/task_20240101_01",
  ptyTabs: [],
  runnerSession: { command: [], pid: null, startedAt: null, lastKnownState: "starting", exitCode: null, exitedAt: null },
  prompt: { source: "inline", value: "prompt" },
  checks: { source: { type: "repo_config", path: ".craig/config.json" }, lastRunAt: null, status: "not_run", commands: [], results: [] },
  lastCommit: null,
  prs,
  artifacts: { logPath: null, checkSummaryPath: null, prDraftPath: null, prStatusPath: null },
  cleanup: { paneClosedAt: null, worktreeRemovedAt: null, preservedWorktree: false, warning: null },
  createdAt: "2024-01-01T00:00:00.000Z",
  updatedAt: "2024-01-01T00:00:00.000Z",
});

describe("getTaskPrimaryPr", () => {
  it("returns null for empty prs array", () => {
    expect(getTaskPrimaryPr(makeTaskWithPrs([]))).toBeNull();
  });

  it("returns the open pr over a merged one", () => {
    const merged = makePr({ number: 1, status: "merged" });
    const open = makePr({ number: 2, status: "open" });
    const task = makeTaskWithPrs([merged, open]);
    expect(getTaskPrimaryPr(task)?.number).toBe(2);
  });

  it("returns the last pr when all are terminal", () => {
    const pr1 = makePr({ number: 1, status: "merged" });
    const pr2 = makePr({ number: 2, status: "closed" });
    const task = makeTaskWithPrs([pr1, pr2]);
    expect(getTaskPrimaryPr(task)?.number).toBe(2);
  });
});

describe("isPrTerminal", () => {
  it("returns true for merged", () => {
    expect(isPrTerminal(makePr({ status: "merged" }))).toBe(true);
  });

  it("returns true for closed", () => {
    expect(isPrTerminal(makePr({ status: "closed" }))).toBe(true);
  });

  it("returns false for open", () => {
    expect(isPrTerminal(makePr({ status: "open" }))).toBe(false);
  });
});

describe("upsertTaskPr", () => {
  it("adds a new pr when number not found", () => {
    const task = makeTaskWithPrs([makePr({ number: 1 })]);
    const result = upsertTaskPr(task, makePr({ number: 2 }));
    expect(result.prs).toHaveLength(2);
  });

  it("replaces an existing pr by number", () => {
    const task = makeTaskWithPrs([makePr({ number: 1, status: "open" })]);
    const result = upsertTaskPr(task, makePr({ number: 1, status: "merged" }));
    expect(result.prs).toHaveLength(1);
    expect(result.prs[0]!.status).toBe("merged");
  });
});

describe("deriveTaskStatusFromPrs", () => {
  it("returns checked for empty prs", () => {
    expect(deriveTaskStatusFromPrs([])).toBe("checked");
  });

  it("returns pr_open for open pr", () => {
    expect(deriveTaskStatusFromPrs([makePr({ status: "open" })])).toBe("pr_open");
  });

  it("returns merged for merged pr", () => {
    expect(deriveTaskStatusFromPrs([makePr({ status: "merged" })])).toBe("merged");
  });

  it("returns merge_ready when all checks pass and pr is mergeable", () => {
    const pr = makePr({
      status: "open",
      mergeable: true,
      mergeStateStatus: "CLEAN",
      requiredChecks: [{ name: "ci", status: "success", conclusion: null }],
    });
    expect(deriveTaskStatusFromPrs([pr])).toBe("merge_ready");
  });
});

describe("isMergeReady", () => {
  it("returns false when not mergeable", () => {
    expect(isMergeReady({ mergeable: false, mergeStateStatus: "CLEAN", requiredChecks: [{ name: "ci", status: "success", conclusion: null }], status: "open" })).toBe(false);
  });

  it("returns false when no required checks", () => {
    expect(isMergeReady({ mergeable: true, mergeStateStatus: "CLEAN", requiredChecks: [], status: "open" })).toBe(false);
  });

  it("returns true when mergeable and all checks pass", () => {
    expect(isMergeReady({
      mergeable: true,
      mergeStateStatus: "CLEAN",
      requiredChecks: [{ name: "ci", status: "success", conclusion: null }],
      status: "open",
    })).toBe(true);
  });
});

describe("summarizeRequiredChecks", () => {
  it("returns no required checks for empty array", () => {
    expect(summarizeRequiredChecks({ requiredChecks: [] })).toBe("no required checks");
  });

  it("summarizes checks by name:status", () => {
    const result = summarizeRequiredChecks({
      requiredChecks: [
        { name: "ci", status: "success", conclusion: null },
        { name: "lint", status: "pending", conclusion: null },
      ],
    });
    expect(result).toBe("ci:success, lint:pending");
  });
});

describe("normalizePr", () => {
  it("preserves existing comments when a lightweight poll omits them", () => {
    const existing = makePr({
      comments: [{
        author: "reviewer",
        body: "Please tighten this.",
        createdAt: "2026-01-01T00:00:00.000Z",
        url: "https://github.com/owner/repo/pull/1#issuecomment-1",
      }],
    });

    const normalized = normalizePr({
      number: 1,
      url: existing.url!,
      baseRefName: "main",
      headRefName: "craig/task_01",
      state: "OPEN",
      mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN",
      statusCheckRollup: [],
    }, existing);

    expect(normalized.comments).toEqual(existing.comments);
  });
});
