import {
  GitHubRateLimitError,
  type TaskPullRequestCheck,
  type TaskRecord,
} from "../domain/task/index.js";

export interface GitHubPollView {
  selectedTaskId: string | null;
  reviewVisible: boolean;
}

export interface GitHubPollIntervals {
  pendingForegroundMs: number;
  pendingBackgroundMs: number;
  stableForegroundMs: number;
  stableBackgroundMs: number;
  discoveryForegroundMs: number;
  discoveryBackgroundMs: number;
  rateLimitBaseMs: number;
  rateLimitMaxMs: number;
}

interface ScheduledTask {
  intervalMs: number;
  nextPollAt: number;
  lastPollAt: number | null;
}

interface PollablePullRequest {
  status: string | null;
  requiredChecks: TaskPullRequestCheck[];
}

const DEFAULT_INTERVALS: GitHubPollIntervals = {
  pendingForegroundMs: 5_000,
  pendingBackgroundMs: 15_000,
  stableForegroundMs: 30_000,
  stableBackgroundMs: 60_000,
  discoveryForegroundMs: 60_000,
  discoveryBackgroundMs: 180_000,
  rateLimitBaseMs: 60_000,
  rateLimitMaxMs: 15 * 60_000,
};

export class GitHubPollCoordinator {
  private readonly scheduledTasks = new Map<string, ScheduledTask>();
  private readonly now: () => number;
  private readonly intervals: GitHubPollIntervals;
  private readonly minimumIntervalMs: number;
  private rateLimitFailures = 0;
  private notBefore = 0;

  constructor(options: {
    minimumIntervalMs?: number;
    intervals?: Partial<GitHubPollIntervals>;
    now?: () => number;
  } = {}) {
    this.minimumIntervalMs = Math.max(1_000, options.minimumIntervalMs ?? 5_000);
    this.intervals = { ...DEFAULT_INTERVALS, ...options.intervals };
    this.now = options.now ?? Date.now;
  }

  takeDueTasks(tasks: readonly TaskRecord[], view: GitHubPollView): TaskRecord[] {
    const now = this.now();
    const activeTaskIds = new Set(tasks.map((task) => task.id));
    for (const taskId of this.scheduledTasks.keys()) {
      if (!activeTaskIds.has(taskId)) {
        this.scheduledTasks.delete(taskId);
      }
    }

    const due: TaskRecord[] = [];
    for (const task of tasks) {
      const intervalMs = this.getTaskIntervalMs(task, view);
      if (intervalMs === null) {
        this.scheduledTasks.delete(task.id);
        continue;
      }

      const scheduled = this.scheduledTasks.get(task.id);
      if (!scheduled) {
        this.scheduledTasks.set(task.id, { intervalMs, nextPollAt: now, lastPollAt: null });
        if (now >= this.notBefore) {
          due.push(task);
        }
        continue;
      }

      if (intervalMs < scheduled.intervalMs) {
        scheduled.nextPollAt = Math.min(scheduled.nextPollAt, now + intervalMs);
      }
      scheduled.intervalMs = intervalMs;
      if (now >= this.notBefore && now >= scheduled.nextPollAt) {
        due.push(task);
      }
    }

    return due;
  }

  requestImmediate(taskIds: readonly string[]): void {
    const now = this.now();
    for (const taskId of taskIds) {
      const scheduled = this.scheduledTasks.get(taskId);
      if (!scheduled) continue;
      const earliestPollAt = scheduled.lastPollAt === null
        ? now
        : Math.max(now, scheduled.lastPollAt + this.minimumIntervalMs);
      scheduled.nextPollAt = Math.min(scheduled.nextPollAt, earliestPollAt);
    }
  }

  recordSuccess(tasks: readonly TaskRecord[], view: GitHubPollView): void {
    const now = this.now();
    this.rateLimitFailures = 0;
    this.notBefore = 0;
    for (const task of tasks) {
      const intervalMs = this.getTaskIntervalMs(task, view);
      if (intervalMs === null) {
        this.scheduledTasks.delete(task.id);
      } else {
        this.scheduledTasks.set(task.id, { intervalMs, nextPollAt: now + intervalMs, lastPollAt: now });
      }
    }
  }

  recordFailure(tasks: readonly TaskRecord[], error: unknown): void {
    const now = this.now();
    const rateLimited = error instanceof GitHubRateLimitError;
    const retryMs = rateLimited
      ? Math.min(
          this.intervals.rateLimitBaseMs * 2 ** this.rateLimitFailures,
          this.intervals.rateLimitMaxMs,
        )
      : Math.max(this.minimumIntervalMs, this.intervals.pendingBackgroundMs);

    if (rateLimited) {
      this.rateLimitFailures += 1;
      this.notBefore = now + retryMs;
    }
    for (const task of tasks) {
      const scheduled = this.scheduledTasks.get(task.id);
      if (scheduled) {
        scheduled.nextPollAt = now + retryMs;
        scheduled.lastPollAt = now;
      }
    }
  }

  private getTaskIntervalMs(task: TaskRecord, view: GitHubPollView): number | null {
    const openPrs = getOpenPullRequests(task);
    const foreground = task.id === view.selectedTaskId && view.reviewVisible;

    if (openPrs.length > 0) {
      const pending = openPrs.some(hasPendingChecks);
      return this.withMinimum(
        pending
          ? foreground
            ? this.intervals.pendingForegroundMs
            : this.intervals.pendingBackgroundMs
          : foreground
            ? this.intervals.stableForegroundMs
            : this.intervals.stableBackgroundMs,
      );
    }

    // A merged PR does not close its task; keep looking for sequential follow-up PRs.
    if (task.status !== "closed") {
      return this.withMinimum(
        foreground ? this.intervals.discoveryForegroundMs : this.intervals.discoveryBackgroundMs,
      );
    }

    return null;
  }

  private withMinimum(intervalMs: number): number {
    return Math.max(intervalMs, this.minimumIntervalMs);
  }
}

function getOpenPullRequests(task: TaskRecord): PollablePullRequest[] {
  if (task.type === "project" && task.repoTargets?.length) {
    return task.repoTargets
      .map((target) => target.pullRequest)
      .filter((pullRequest) => pullRequest.status === "open");
  }
  return task.prs.filter((pullRequest) => pullRequest.status === "open");
}

function hasPendingChecks(pullRequest: PollablePullRequest): boolean {
  return pullRequest.requiredChecks.some((check) => check.status === "pending" || check.status === "unknown");
}
