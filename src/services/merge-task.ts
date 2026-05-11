import type { CommandMergeResult } from "../types/command.js";
import type { CraigPaths } from "../state/craig-paths.js";
import type { TaskRecord } from "../types/task.js";
import { readCraigConfig } from "../state/config-store.js";
import { writeTask } from "../state/task-store.js";
import { cleanupTask } from "./cleanup-task.js";
import { getHeadCommit, isWorktreeClean } from "./git-task.js";
import {
  ensureGhAuthenticated,
  isMergeReady,
  mergeGitHubPullRequest,
  refreshPullRequestState,
} from "./github-pr.js";
import { assertTaskWorktreeExists, getTaskOrThrow } from "./task-inspection.js";
import { deriveAggregateTaskStatus, getTaskWorktree, syncPrimaryReviewMirrors } from "./task-worktrees.js";

export async function mergeTask(
  paths: CraigPaths,
  taskId: string,
  options: { preserveWorktree: boolean; repoId?: string },
): Promise<CommandMergeResult> {
  const task = await getTaskOrThrow(paths, taskId);
  const worktree = getTaskWorktree(task, options.repoId);
  const review = task.repoReviews[worktree.repoId] ?? task.repoReviews[task.repoId];
  await assertTaskWorktreeExists(task, worktree.repoId);

  if (task.status !== "pr_open" && task.status !== "merge_ready") {
    throw new Error(`Task ${task.id} cannot merge from status "${task.status}".`);
  }

  if (!review?.pullRequest.number) {
    throw new Error(`Task ${task.id} repo ${worktree.repoId} does not have a tracked pull request.`);
  }

  if (!review.lastCommit) {
    throw new Error(`Task ${task.id} repo ${worktree.repoId} must be committed before merging.`);
  }

  if (!(await isWorktreeClean(worktree.worktreePath))) {
    throw new Error(`Task ${task.id} repo ${worktree.repoId} worktree must be clean before merging.`);
  }

  const headCommit = await getHeadCommit(worktree.worktreePath);
  if (headCommit.sha !== review.lastCommit.sha) {
    throw new Error(`Task ${task.id} repo ${worktree.repoId} local HEAD does not match the tracked task commit. Sync or commit before merging.`);
  }

  await ensureGhAuthenticated(worktree.worktreePath);
  const refreshed = await refreshPullRequestState(paths, task, worktree.repoId);
  const refreshedReview = refreshed.repoReviews[worktree.repoId]!;

  const blockers = getMergeBlockers(refreshed, worktree.repoId);
  if (blockers.length > 0) {
    throw new Error(`pull request for repo ${worktree.repoId} is not merge-ready: ${blockers.join("; ")}.`);
  }

  const config = await readCraigConfig(paths);
  const mergeMethod = config.github?.mergeMethod ?? "squash";

  await mergeGitHubPullRequest(refreshed, mergeMethod, worktree.repoId);

  refreshedReview.pullRequest.status = "merged";
  refreshedReview.status = "merged";
  refreshedReview.lastFailureReason = null;
  refreshedReview.updatedAt = new Date().toISOString();
  refreshed.status = deriveAggregateTaskStatus(refreshed);
  refreshed.lastFailureReason = null;
  const mirrored = syncPrimaryReviewMirrors(refreshed);
  await writeTask(paths, mirrored);

  await cleanupTask(paths, mirrored, options);

  return {
    kind: "mergeTask",
    taskId: mirrored.id,
    repoId: worktree.repoId,
    status: mirrored.status,
    prNumber: refreshedReview.pullRequest.number ?? 0,
    preservedWorktree: options.preserveWorktree,
    cleanupWarning: mirrored.cleanup.warning,
  };
}

function getMergeBlockers(task: TaskRecord, repoId: string): string[] {
  const blockers: string[] = [];
  const review = task.repoReviews[repoId];
  const pr = review?.pullRequest;

  if (!review || !pr) {
    return [`repo ${repoId} has no review state`];
  }

  if (pr.status !== "open") {
    blockers.push(`PR is ${pr.status ?? "unknown"}`);
  }

  if (!pr.mergeable) {
    blockers.push(`GitHub reports merge state ${pr.mergeStateStatus ?? "unknown"}`);
  }

  if (pr.lastSyncedHeadSha !== review.lastCommit?.sha) {
    blockers.push("local task commit is not synced to the PR head");
  }

  if (pr.requiredChecks.length === 0) {
    blockers.push("no GitHub checks reported");
  }

  for (const status of ["failed", "pending", "unknown"] as const) {
    const names = pr.requiredChecks.filter((check) => check.status === status).map((check) => check.name);
    if (names.length > 0) {
      blockers.push(`${status} checks: ${names.join(", ")}`);
    }
  }

  if (!isMergeReady(pr)) {
    blockers.push("required checks are not passing");
  }

  return [...new Set(blockers)];
}
