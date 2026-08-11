import { describe, expect, test } from "vitest";

import { GitHubRateLimitError, type TaskRecord } from "../domain/task/index.js";
import { GitHubPollCoordinator, type GitHubPollView } from "./github-poll-coordinator.js";

const BACKGROUND: GitHubPollView = { selectedTaskId: null, reviewVisible: false };

describe("GitHubPollCoordinator", () => {
  test("initially syncs every non-closed task and skips only closed tasks", () => {
    const coordinator = new GitHubPollCoordinator({ now: () => 0 });
    const tasks = [
      task("pending", "pr_open", "pending"),
      task("discovery", "checked"),
      task("running", "running"),
      task("draft", "draft"),
      task("merged", "merged"),
      task("closed", "closed"),
    ];

    expect(coordinator.takeDueTasks(tasks, BACKGROUND).map((entry) => entry.id)).toEqual([
      "pending",
      "discovery",
      "running",
      "draft",
      "merged",
    ]);
  });

  test("uses a five-second foreground lane and fifteen-second background lane for pending checks", () => {
    let now = 0;
    const coordinator = new GitHubPollCoordinator({ now: () => now });
    const foregroundTask = task("foreground", "pr_open", "pending");
    const backgroundTask = task("background", "pr_open", "pending");
    const tasks = [foregroundTask, backgroundTask];
    const view = { selectedTaskId: foregroundTask.id, reviewVisible: true };

    expect(coordinator.takeDueTasks(tasks, view)).toEqual(tasks);
    coordinator.recordSuccess(tasks, view);
    now = 5_000;
    expect(coordinator.takeDueTasks(tasks, view).map((entry) => entry.id)).toEqual(["foreground"]);
    coordinator.recordSuccess([foregroundTask], view);
    now = 15_000;
    expect(coordinator.takeDueTasks(tasks, view).map((entry) => entry.id)).toEqual(["foreground", "background"]);
  });

  test("backs stable PRs and discovery tasks off to their slower lanes", () => {
    let now = 0;
    const coordinator = new GitHubPollCoordinator({ now: () => now });
    const stable = task("stable", "pr_open", "success");
    const discovery = task("discovery", "checked");
    const merged = task("merged", "merged");
    const tasks = [stable, discovery, merged];

    coordinator.takeDueTasks(tasks, BACKGROUND);
    coordinator.recordSuccess(tasks, BACKGROUND);
    now = 60_000;
    expect(coordinator.takeDueTasks(tasks, BACKGROUND).map((entry) => entry.id)).toEqual(["stable"]);
    coordinator.recordSuccess([stable], BACKGROUND);
    now = 180_000;
    expect(coordinator.takeDueTasks(tasks, BACKGROUND).map((entry) => entry.id)).toEqual([
      "stable",
      "discovery",
      "merged",
    ]);
  });

  test("applies a cross-tick cooldown after a rate limit", () => {
    let now = 0;
    const coordinator = new GitHubPollCoordinator({ now: () => now });
    const pending = task("pending", "pr_open", "pending");

    expect(coordinator.takeDueTasks([pending], BACKGROUND)).toEqual([pending]);
    coordinator.recordFailure([pending], new GitHubRateLimitError("API rate limit exceeded"));
    now = 15_000;
    expect(coordinator.takeDueTasks([pending], BACKGROUND)).toEqual([]);
    now = 59_999;
    expect(coordinator.takeDueTasks([pending], BACKGROUND)).toEqual([]);
    now = 60_000;
    expect(coordinator.takeDueTasks([pending], BACKGROUND)).toEqual([pending]);
  });

  test("treats the configured watch interval as a minimum", () => {
    let now = 0;
    const coordinator = new GitHubPollCoordinator({ minimumIntervalMs: 60_000, now: () => now });
    const pending = task("pending", "pr_open", "pending");
    const view = { selectedTaskId: pending.id, reviewVisible: true };

    coordinator.takeDueTasks([pending], view);
    coordinator.recordSuccess([pending], view);
    now = 5_000;
    expect(coordinator.takeDueTasks([pending], view)).toEqual([]);
    now = 60_000;
    expect(coordinator.takeDueTasks([pending], view)).toEqual([pending]);
  });

  test("pulls an event-triggered poll forward without bypassing the configured minimum", () => {
    let now = 0;
    const coordinator = new GitHubPollCoordinator({ minimumIntervalMs: 5_000, now: () => now });
    const discovery = task("discovery", "checked");

    coordinator.takeDueTasks([discovery], BACKGROUND);
    coordinator.recordSuccess([discovery], BACKGROUND);
    now = 1_000;
    coordinator.requestImmediate([discovery.id]);
    expect(coordinator.takeDueTasks([discovery], BACKGROUND)).toEqual([]);
    now = 4_999;
    expect(coordinator.takeDueTasks([discovery], BACKGROUND)).toEqual([]);
    now = 5_000;
    expect(coordinator.takeDueTasks([discovery], BACKGROUND)).toEqual([discovery]);
  });
});

function task(
  id: string,
  status: TaskRecord["status"],
  checkStatus?: "pending" | "success",
): TaskRecord {
  return {
    id,
    title: id,
    slug: id,
    type: "repo",
    status,
    runner: "codex",
    repoId: "repo",
    workspaceId: "workspace",
    sessionId: null,
    selectedPtyTabId: null,
    linkedRepoIds: [],
    parentTaskId: null,
    rootTaskId: id,
    delegationDepth: 0,
    delegationIdempotencyKey: null,
    furyRunId: null,
    furyStepId: null,
    repoRoot: "/repo",
    worktreePath: `/repo/${id}`,
    branch: `craig/${id}`,
    ptyTabs: [],
    runnerSession: {
      command: [],
      pid: null,
      startedAt: null,
      lastKnownState: "running",
      exitCode: null,
      exitedAt: null,
    },
    prompt: { source: "inline", value: id },
    checks: {
      source: { type: "repo_config", path: ".craig/config.json" },
      lastRunAt: null,
      status: "passed",
      commands: [],
      results: [],
    },
    lastCommit: null,
    prs: checkStatus
      ? [{
          provider: "github",
          owner: "owner",
          repo: "repo",
          number: 1,
          url: "https://github.com/owner/repo/pull/1",
          title: id,
          status: "open",
          draft: false,
          baseBranch: "main",
          headBranch: `craig/${id}`,
          mergeable: true,
          mergeStateStatus: "CLEAN",
          requiredChecks: [{ name: "ci", status: checkStatus, conclusion: null }],
          comments: [],
          createdAt: null,
          updatedAt: null,
          mergedAt: null,
          lastSyncedAt: null,
          lastSyncedHeadSha: null,
        }]
      : [],
    artifacts: { logPath: null, checkSummaryPath: null, prDraftPath: null, prStatusPath: null },
    cleanup: {
      paneClosedAt: null,
      worktreeRemovedAt: null,
      preservedWorktree: false,
      warning: null,
    },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}
