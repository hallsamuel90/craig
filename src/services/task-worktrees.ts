import path from "node:path";

import type { TaskRepoReview, TaskRecord, TaskWorktree } from "../types/task.js";

export function getPrimaryWorktree(task: TaskRecord): TaskWorktree {
  return task.worktrees.find((worktree) => worktree.role === "primary") ?? task.worktrees[0] ?? {
    repoId: task.repoId,
    repoRoot: task.repoRoot,
    worktreePath: task.worktreePath,
    branch: task.branch,
    role: "primary",
  };
}

export function getTaskWorktree(task: TaskRecord, repoId?: string | null): TaskWorktree {
  const targetRepoId = repoId ?? task.repoId;
  const worktree = task.worktrees.find((entry) => entry.repoId === targetRepoId);

  if (!worktree) {
    throw new Error(`Task ${task.id} does not include repo ${targetRepoId}.`);
  }

  return worktree;
}

export function getTaskBundlePath(task: TaskRecord): string {
  if (task.worktrees.length <= 1) {
    return task.worktreePath;
  }

  return path.dirname(getPrimaryWorktree(task).worktreePath);
}

export function listChangedTaskWorktrees(task: TaskRecord): TaskWorktree[] {
  return task.worktrees.filter((worktree) => {
    const review = task.repoReviews[worktree.repoId];
    return Boolean(review && review.status !== "not_changed" && review.status !== "closed");
  });
}

export function createEmptyPullRequest(): TaskRecord["pullRequest"] {
  return {
    provider: "github",
    number: null,
    url: null,
    baseBranch: null,
    headBranch: null,
    status: null,
    mergeable: false,
    mergeStateStatus: null,
    requiredChecks: [],
    lastSyncedAt: null,
    lastSyncedHeadSha: null,
  };
}

export function createRepoReview(repoId: string, timestamp = new Date().toISOString()): TaskRepoReview {
  return {
    repoId,
    lastCommit: null,
    pullRequest: createEmptyPullRequest(),
    status: "not_changed",
    lastFailureReason: null,
    updatedAt: timestamp,
  };
}

export function syncPrimaryReviewMirrors(task: TaskRecord): TaskRecord {
  const primary = getPrimaryWorktree(task);
  const primaryReview = task.repoReviews[primary.repoId] ?? createRepoReview(primary.repoId, task.updatedAt);
  const linkedRepoIds = task.worktrees
    .filter((worktree) => worktree.role !== "primary")
    .map((worktree) => worktree.repoId);

  return {
    ...task,
    repoId: primary.repoId,
    repoRoot: primary.repoRoot,
    worktreePath: primary.worktreePath,
    branch: primary.branch,
    linkedRepoIds,
    lastCommit: primaryReview.lastCommit,
    pullRequest: primaryReview.pullRequest,
  };
}

export function deriveAggregateTaskStatus(task: TaskRecord): TaskRecord["status"] {
  if (task.status === "closed") {
    return "closed";
  }

  const reviews = Object.values(task.repoReviews).filter((review) => review.status !== "not_changed");

  if (reviews.length === 0) {
    return task.status === "draft" ? "draft" : task.status === "running" ? "running" : "review";
  }

  if (reviews.every((review) => review.status === "merged" || review.status === "closed")) {
    return "merged";
  }

  if (reviews.some((review) => review.status === "merge_ready")) {
    return "merge_ready";
  }

  if (reviews.some((review) => review.status === "pr_open")) {
    return "pr_open";
  }

  if (reviews.some((review) => review.status === "committed")) {
    return "checked";
  }

  return "review";
}
