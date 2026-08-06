import { describe, expect, test, vi } from "vitest";

import { GitHubRateLimitError, type TaskRecord } from "../domain/task/index.js";
import type { CraigEvent } from "../domain/orchestration/index.js";
import { getCraigPaths } from "../state/craig-paths.js";
import {
  PullRequestSyncSupervisor,
  getPullRequestSyncWakeTaskIds,
  type PullRequestSyncDependencies,
} from "./pull-request-sync-supervisor.js";

describe("PullRequestSyncSupervisor", () => {
  test("synchronizes due tasks, reports persisted PR changes, and respects the next interval", async () => {
    let now = 0;
    let task = buildTask("task_1", "checked");
    const onTasksChanged = vi.fn();
    const dependencies = dependenciesFor(
      () => [task],
      vi.fn(async () => {
        task = buildTask("task_1", "pr_open", "pending");
        return [task];
      }),
    );
    const supervisor = new PullRequestSyncSupervisor(getCraigPaths("/workspace"), {
      now: () => now,
      dependencies,
      onTasksChanged,
    });

    await supervisor.wake();
    expect(dependencies.syncTasks).toHaveBeenCalledOnce();
    expect(onTasksChanged).toHaveBeenCalledWith(["task_1"]);

    await supervisor.wake();
    expect(dependencies.syncTasks).toHaveBeenCalledOnce();
    now = 15_000;
    await supervisor.wake();
    expect(dependencies.syncTasks).toHaveBeenCalledTimes(2);
  });

  test("uses the foreground review cadence supplied by a connected TUI", async () => {
    let now = 0;
    const task = buildTask("task_1", "checked");
    const syncTasks = vi.fn(async () => [task]);
    const supervisor = new PullRequestSyncSupervisor(getCraigPaths("/workspace"), {
      now: () => now,
      dependencies: dependenciesFor(() => [task], syncTasks),
    });

    await supervisor.wake();
    supervisor.setView({ selectedTaskId: task.id, reviewVisible: true });
    await supervisor.wake();
    now = 59_999;
    await supervisor.wake();
    expect(syncTasks).toHaveBeenCalledOnce();
    now = 60_000;
    await supervisor.wake();
    expect(syncTasks).toHaveBeenCalledTimes(2);
  });

  test("applies rate-limit backoff and deduplicates repeated background errors", async () => {
    let now = 0;
    const task = buildTask("task_1", "checked");
    const error = new GitHubRateLimitError("API rate limit exceeded");
    const syncTasks = vi.fn(async () => { throw error; });
    const onError = vi.fn();
    const supervisor = new PullRequestSyncSupervisor(getCraigPaths("/workspace"), {
      now: () => now,
      dependencies: dependenciesFor(() => [task], syncTasks),
      onError,
    });

    await supervisor.wake();
    now = 59_999;
    await supervisor.wake();
    expect(syncTasks).toHaveBeenCalledOnce();
    now = 60_000;
    await supervisor.wake();
    expect(syncTasks).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledOnce();
  });

  test("reports changes persisted before a partially failed synchronization cycle", async () => {
    let task = buildTask("task_1", "checked");
    const error = new Error("second repository failed");
    const onTasksChanged = vi.fn();
    const supervisor = new PullRequestSyncSupervisor(getCraigPaths("/workspace"), {
      dependencies: dependenciesFor(
        () => [task],
        vi.fn(async () => {
          task = buildTask("task_1", "pr_open", "pending");
          throw error;
        }),
      ),
      onTasksChanged,
    });

    await supervisor.wake();

    expect(onTasksChanged).toHaveBeenCalledWith(["task_1"]);
  });

  test("serializes overlapping heartbeat and wake reconciliation", async () => {
    const task = buildTask("task_1", "checked");
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const syncTasks = vi.fn(async () => {
      await pending;
      return [task];
    });
    const supervisor = new PullRequestSyncSupervisor(getCraigPaths("/workspace"), {
      dependencies: dependenciesFor(() => [task], syncTasks),
    });

    const first = supervisor.wake();
    const second = supervisor.wake();
    await Promise.resolve();
    await Promise.resolve();
    expect(syncTasks).toHaveBeenCalledOnce();
    release();
    await Promise.all([first, second]);
    expect(syncTasks).toHaveBeenCalledOnce();
  });

  test("pulls a task poll forward after an event while respecting the minimum interval", async () => {
    let now = 0;
    const task = buildTask("task_1", "checked");
    const syncTasks = vi.fn(async () => [task]);
    const supervisor = new PullRequestSyncSupervisor(getCraigPaths("/workspace"), {
      now: () => now,
      minimumIntervalMs: 5_000,
      dependencies: dependenciesFor(() => [task], syncTasks),
    });

    await supervisor.wake();
    now = 1_000;
    await supervisor.wake([task.id]);
    expect(syncTasks).toHaveBeenCalledOnce();
    now = 5_000;
    await supervisor.wake();
    expect(syncTasks).toHaveBeenCalledTimes(2);
  });

  test("selects semantic task and agent events without feeding PR refreshes back into polling", () => {
    expect(getPullRequestSyncWakeTaskIds([
      event("task.created", "task_created", {}),
      event("task.updated", "task_commit", { changedFields: ["lastCommitSha"] }),
      event("task.updated", "task_status", { changedFields: [] }),
      event("task.pr.refreshed", "task_refresh", {}),
      event("task.pr.unlinked", "task_unlinked", {}),
      event("agent.state.changed", "task_ready", { previousState: "working", state: "ready" }),
      event("agent.state.changed", "task_working", { previousState: "idle", state: "working" }),
      event("task.updated", "task_commit", { changedFields: ["checksStatus"] }),
    ])).toEqual(["task_created", "task_commit", "task_unlinked", "task_ready"]);
  });
});

function event(type: string, taskId: string, data: unknown): CraigEvent {
  return {
    schemaVersion: 1,
    id: `${type}:${taskId}`,
    sequence: 1,
    workspaceId: "workspace",
    taskId,
    agentTabId: null,
    commandId: null,
    swarmRunId: null,
    swarmStepId: null,
    type,
    occurredAt: "2026-01-01T00:00:00.000Z",
    actor: { type: "system", component: "heartbeat" },
    data,
  };
}

function dependenciesFor(
  listTasks: () => TaskRecord[],
  syncTasks: PullRequestSyncDependencies["syncTasks"],
): PullRequestSyncDependencies {
  return {
    listTasks: async () => listTasks(),
    syncTasks: vi.fn(syncTasks),
  };
}

function buildTask(
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
