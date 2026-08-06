import type { TaskRecord } from "../domain/task/index.js";
import { taskService } from "../domain/task/index.js";
import type { CraigPaths } from "../state/craig-paths.js";
import {
  GitHubPollCoordinator,
  type GitHubPollIntervals,
  type GitHubPollView,
} from "./github-poll-coordinator.js";
import { Heartbeat } from "./heartbeat.js";

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
  private reconciliation: Promise<void> | null = null;
  private view = BACKGROUND_POLL_VIEW;
  private running = false;
  private lastErrorMessage: string | null = null;

  /* eslint-disable no-unused-vars */
  constructor(
    private readonly paths: CraigPaths,
    options: PullRequestSyncSupervisorOptions = {},
  ) {
    /* eslint-enable no-unused-vars */
    const heartbeatIntervalMs = options.heartbeatIntervalMs ?? 1_000;
    this.dependencies = options.dependencies ?? defaultDependencies;
    this.onTasksChanged = options.onTasksChanged ?? (() => undefined);
    this.onError = options.onError ?? (() => undefined);
    this.coordinator = new GitHubPollCoordinator({
      ...(options.minimumIntervalMs !== undefined ? { minimumIntervalMs: options.minimumIntervalMs } : {}),
      ...(options.intervals ? { intervals: options.intervals } : {}),
      ...(options.now ? { now: options.now } : {}),
    });
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
    this.heartbeat.start();
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.heartbeat.stop();
    await this.reconciliation?.catch(() => undefined);
  }

  setView(view: GitHubPollView): void {
    this.view = view;
  }

  async wake(): Promise<void> {
    await this.reconcile();
  }

  private reconcile(): Promise<void> {
    if (this.reconciliation) return this.reconciliation;
    this.reconciliation = this.reconcilePullRequests().finally(() => {
      this.reconciliation = null;
    });
    return this.reconciliation;
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

function taskPullRequestSignature(task: TaskRecord): string {
  return JSON.stringify({
    status: task.status,
    prs: task.prs,
    repoTargets: task.repoTargets ?? null,
  });
}
