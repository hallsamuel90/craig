import type { TaskRecord } from "../domain/task/index.js";
import { taskService } from "../domain/task/index.js";
import type { CraigEvent } from "../domain/orchestration/index.js";
import type { PtyActivitySnapshot } from "../domain/agent/index.js";
import type { CraigPaths } from "../state/craig-paths.js";
import {
  GitHubPollCoordinator,
  type GitHubPollIntervals,
  type GitHubPollView,
} from "./github-poll-coordinator.js";
import { Heartbeat } from "./heartbeat.js";
import { PullRequestEventMonitor } from "./pull-request-event-monitor.js";

const BACKGROUND_POLL_VIEW: GitHubPollView = {
  selectedTaskId: null,
  reviewVisible: false,
};

/* eslint-disable no-unused-vars */
export interface PullRequestSyncDependencies {
  listTasks(paths: CraigPaths): Promise<TaskRecord[]>;
  syncTasks(paths: CraigPaths, tasks: TaskRecord[]): Promise<TaskRecord[]>;
}

export interface PullRequestSyncSupervisorOptions {
  minimumIntervalMs?: number;
  intervals?: Partial<GitHubPollIntervals>;
  heartbeatIntervalMs?: number;
  now?: () => number;
  dependencies?: PullRequestSyncDependencies;
  reconcileEvents?: false | (() => Promise<CraigEvent[]>);
  onTasksChanged?: (taskIds: string[]) => void | Promise<void>;
  onError?: (error: unknown) => void | Promise<void>;
}
/* eslint-enable no-unused-vars */

const defaultDependencies: PullRequestSyncDependencies = {
  listTasks: async (paths) => (await taskService.listTasks(paths)).tasks,
  syncTasks: async (paths, tasks) => {
    await taskService.prs.discoverOrRefreshMany(paths, tasks);
    return Promise.all(tasks.map((task) => taskService.getTask(paths, task.id)));
  },
};

export class PullRequestSyncSupervisor {
  private readonly heartbeat: Heartbeat;
  private readonly coordinator: GitHubPollCoordinator;
  private readonly dependencies: PullRequestSyncDependencies;
  private readonly onTasksChanged: NonNullable<PullRequestSyncSupervisorOptions["onTasksChanged"]>;
  private readonly onError: NonNullable<PullRequestSyncSupervisorOptions["onError"]>;
  private readonly eventMonitor: PullRequestEventMonitor | null;
  private readonly pendingWakeTaskIds = new Set<string>();
  private reconciliation: Promise<void> | null = null;
  private reconciliationVersion = 0;
  private view = BACKGROUND_POLL_VIEW;
  private running = false;
  private lastErrorMessage: string | null = null;

  constructor(
    private readonly paths: CraigPaths,
    options: PullRequestSyncSupervisorOptions = {},
  ) {
    const heartbeatIntervalMs = options.heartbeatIntervalMs ?? 1_000;
    this.dependencies = options.dependencies ?? defaultDependencies;
    this.onTasksChanged = options.onTasksChanged ?? (() => undefined);
    this.onError = options.onError ?? (() => undefined);
    this.coordinator = new GitHubPollCoordinator({
      ...(options.minimumIntervalMs !== undefined ? { minimumIntervalMs: options.minimumIntervalMs } : {}),
      ...(options.intervals ? { intervals: options.intervals } : {}),
      ...(options.now ? { now: options.now } : {}),
    });
    this.eventMonitor = options.reconcileEvents
      ? new PullRequestEventMonitor(paths, {
          reconcileEvents: options.reconcileEvents,
          onEvents: async (events) => {
            const changedTaskIds = getTaskLifecycleEventTaskIds(events);
            if (changedTaskIds.length > 0) await this.onTasksChanged(changedTaskIds);
            const taskIds = getPullRequestSyncWakeTaskIds(events);
            if (taskIds.length > 0) await this.wake(taskIds);
          },
          onError: (error) => this.reportError(error),
          ...(options.now ? { now: options.now } : {}),
        })
      : null;
    this.heartbeat = new Heartbeat({
      resolutionMs: heartbeatIntervalMs,
      ...(options.now ? { now: options.now } : {}),
      onError: (_jobId, error) => this.reportError(error),
    });
    this.heartbeat.register({
      id: "github.pull-requests",
      intervalMs: heartbeatIntervalMs,
      run: () => this.reconcile(),
    });
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.eventMonitor?.start();
    this.heartbeat.start();
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.heartbeat.stop();
    await this.eventMonitor?.stop();
    await this.reconciliation?.catch(() => undefined);
  }

  setView(view: GitHubPollView): void {
    this.view = view;
  }

  notifyActivity(snapshot: PtyActivitySnapshot): void {
    this.eventMonitor?.notifyActivity(snapshot);
  }

  notifyActivityRemoved(tabId: string): void {
    this.eventMonitor?.notifyActivityRemoved(tabId);
  }

  async wake(taskIds?: readonly string[]): Promise<void> {
    if (taskIds?.length) {
      for (const taskId of taskIds) this.pendingWakeTaskIds.add(taskId);
      this.reconciliationVersion += 1;
    }
    await this.reconcile();
  }

  private reconcile(): Promise<void> {
    if (this.reconciliation) return this.reconciliation;
    this.reconciliation = this.drainReconciliations();
    return this.reconciliation;
  }

  private async drainReconciliations(): Promise<void> {
    try {
      while (true) {
        const version = this.reconciliationVersion;
        const immediateTaskIds = [...this.pendingWakeTaskIds];
        this.pendingWakeTaskIds.clear();
        this.coordinator.requestImmediate(immediateTaskIds);
        await this.reconcilePullRequests();
        if (version === this.reconciliationVersion) return;
      }
    } finally {
      this.reconciliation = null;
    }
  }

  private async reconcilePullRequests(): Promise<void> {
    const tasks = await this.dependencies.listTasks(this.paths);
    const view = this.view;
    const dueTasks = this.coordinator.takeDueTasks(tasks, view);
    if (dueTasks.length === 0) return;

    const before = new Map(dueTasks.map((task) => [task.id, taskPullRequestSignature(task)]));
    let updatedTasks: TaskRecord[];
    try {
      updatedTasks = await this.dependencies.syncTasks(this.paths, dueTasks);
    } catch (error) {
      this.coordinator.recordFailure(dueTasks, error);
      await this.reportPersistedChangesAfterFailure(before);
      await this.reportError(error);
      return;
    }

    this.coordinator.recordSuccess(updatedTasks, this.view);
    this.lastErrorMessage = null;
    await this.reportChangedTasks(before, updatedTasks);
  }

  private async reportPersistedChangesAfterFailure(before: Map<string, string>): Promise<void> {
    try {
      const currentTasks = await this.dependencies.listTasks(this.paths);
      await this.reportChangedTasks(before, currentTasks.filter((task) => before.has(task.id)));
    } catch (error) {
      await this.reportError(error);
    }
  }

  private async reportChangedTasks(before: Map<string, string>, tasks: TaskRecord[]): Promise<void> {
    const changedTaskIds = tasks
      .filter((task) => before.get(task.id) !== taskPullRequestSignature(task))
      .map((task) => task.id);
    if (changedTaskIds.length > 0) {
      await this.onTasksChanged(changedTaskIds);
    }
  }

  private async reportError(error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    if (message === this.lastErrorMessage) return;
    this.lastErrorMessage = message;
    await this.onError(error);
  }
}

export function getPullRequestSyncWakeTaskIds(events: readonly CraigEvent[]): string[] {
  const taskIds = new Set<string>();
  for (const event of events) {
    if (!event.taskId) continue;
    if (event.type === "task.created" || event.type === "task.pr.unlinked") {
      taskIds.add(event.taskId);
      continue;
    }
    const data = asRecord(event.data);
    if (event.type === "task.updated") {
      const changedFields = Array.isArray(data?.changedFields) ? data.changedFields : [];
      if (changedFields.some((field) => typeof field === "string" && PR_WAKE_TASK_FIELDS.has(field))) {
        taskIds.add(event.taskId);
      }
      continue;
    }
    if (
      event.type === "agent.state.changed" &&
      data?.previousState === "working" &&
      (data.state === "ready" || data.state === "idle" || data.state === "error")
    ) {
      taskIds.add(event.taskId);
    }
  }
  return [...taskIds];
}

export function getTaskLifecycleEventTaskIds(events: readonly CraigEvent[]): string[] {
  const taskIds = new Set<string>();
  for (const event of events) {
    if (event.taskId && isTaskLifecycleEvent(event)) taskIds.add(event.taskId);
  }
  return [...taskIds];
}

function isTaskLifecycleEvent(event: CraigEvent): boolean {
  return event.type === "task.created" || event.type === "task.updated" || event.type === "task.closed";
}

const PR_WAKE_TASK_FIELDS = new Set(["branch", "lastCommitSha", "checksStatus", "checksLastRunAt"]);

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;

function taskPullRequestSignature(task: TaskRecord): string {
  return JSON.stringify({
    status: task.status,
    prs: task.prs,
    repoTargets: task.repoTargets ?? null,
  });
}
