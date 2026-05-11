import type { CommandPullRequestResult } from "../types/command.js";
import type { CraigPaths } from "../state/craig-paths.js";
import { writeTask } from "../state/task-store.js";
import { ensureOriginRemote, isWorktreeClean, pushBranch } from "./git-task.js";
import {
  createGitHubPullRequest,
  ensureGhAuthenticated,
  ensurePrDraft,
  isMergeReady,
  refreshPullRequestState,
  summarizeRequiredChecks,
  waitForPullRequestState,
  writePrStatusArtifact,
} from "./github-pr.js";
import { assertTaskWorktreeExists, getTaskOrThrow } from "./task-inspection.js";
import { getTaskWorktree, syncPrimaryReviewMirrors } from "./task-worktrees.js";

export async function openPullRequest(
  paths: CraigPaths,
  taskId: string,
  options: { watch: boolean; repoId?: string },
): Promise<CommandPullRequestResult> {
  const task = await getTaskOrThrow(paths, taskId);
  const worktree = getTaskWorktree(task, options.repoId);
  const review = task.repoReviews[worktree.repoId] ?? task.repoReviews[task.repoId];
  await assertTaskWorktreeExists(task, worktree.repoId);

  if (task.status !== "checked" && task.status !== "pr_open" && task.status !== "merge_ready") {
    throw new Error(`Task ${task.id} cannot open a pull request from status "${task.status}".`);
  }

  if (!review?.lastCommit) {
    throw new Error(`Task ${task.id} repo ${worktree.repoId} must be committed before opening a pull request.`);
  }

  if (!(await isWorktreeClean(worktree.worktreePath))) {
    throw new Error(`Task ${task.id} repo ${worktree.repoId} worktree must be clean before opening a pull request.`);
  }

  await ensureOriginRemote(worktree.worktreePath);
  await ensureGhAuthenticated(worktree.worktreePath);

  const prDraftPath = await ensurePrDraft(task, paths);
  await writeTask(paths, syncPrimaryReviewMirrors(task));

  await pushBranch(worktree.worktreePath, worktree.branch);

  if (!review.pullRequest.number) {
    await createGitHubPullRequest(task, prDraftPath, worktree.repoId);
  }

  const refreshed = await refreshPullRequestState(paths, task, worktree.repoId);
  const refreshedReview = refreshed.repoReviews[worktree.repoId]!;

  if (options.watch && refreshedReview.pullRequest.status !== "merged" && !isMergeReady(refreshedReview.pullRequest)) {
    await waitForPullRequestState(paths, refreshed);
  }

  await writePrStatusArtifact(paths, refreshed);

  return {
    kind: "openPullRequest",
    taskId: refreshed.id,
    repoId: worktree.repoId,
    watch: options.watch,
    prNumber: refreshedReview.pullRequest.number ?? 0,
    url: refreshedReview.pullRequest.url ?? "",
    status: refreshed.status,
    mergeable: refreshedReview.pullRequest.mergeable,
    requiredChecksSummary: summarizeRequiredChecks(refreshedReview.pullRequest),
  };
}

export async function refreshTrackedPullRequest(paths: CraigPaths, taskId: string) {
  const task = await getTaskOrThrow(paths, taskId);

  if (!task.pullRequest.number) {
    return task;
  }

  const worktree = getTaskWorktree(task, task.repoId);
  await ensureGhAuthenticated(worktree.worktreePath);
  return refreshPullRequestState(paths, task);
}

export async function refreshPullRequestChecks(paths: CraigPaths, taskId: string, options: { repoId?: string } = {}) {
  const task = await getTaskOrThrow(paths, taskId);
  const worktree = getTaskWorktree(task, options.repoId);
  const review = task.repoReviews[worktree.repoId] ?? task.repoReviews[task.repoId];

  if (!review?.pullRequest.number) {
    throw new Error("no tracked PR.");
  }

  await assertTaskWorktreeExists(task, worktree.repoId);
  await ensureGhAuthenticated(worktree.worktreePath);
  const refreshed = await refreshPullRequestState(paths, task, worktree.repoId);
  await writePrStatusArtifact(paths, refreshed);
  return refreshed;
}
