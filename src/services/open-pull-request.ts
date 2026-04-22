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

export async function openPullRequest(
  paths: CraigPaths,
  taskId: string,
  options: { watch: boolean },
): Promise<CommandPullRequestResult> {
  const task = await getTaskOrThrow(paths, taskId);
  await assertTaskWorktreeExists(task);

  if (task.status !== "checked" && task.status !== "pr_open" && task.status !== "merge_ready") {
    throw new Error(`Task ${task.id} cannot open a pull request from status "${task.status}".`);
  }

  if (!task.lastCommit) {
    throw new Error(`Task ${task.id} must be committed before opening a pull request.`);
  }

  if (!(await isWorktreeClean(task.worktreePath))) {
    throw new Error(`Task ${task.id} worktree must be clean before opening a pull request.`);
  }

  await ensureOriginRemote(task.worktreePath);
  await ensureGhAuthenticated(task.worktreePath);

  const prDraftPath = await ensurePrDraft(task, paths);
  await writeTask(paths, task);

  await pushBranch(task.worktreePath, task.branch);

  if (!task.pullRequest.number) {
    await createGitHubPullRequest(task, prDraftPath);
  }

  await refreshPullRequestState(paths, task);

  if (options.watch && task.pullRequest.status !== "merged" && !isMergeReady(task.pullRequest)) {
    await waitForPullRequestState(paths, task);
  }

  await writePrStatusArtifact(paths, task);

  return {
    kind: "openPullRequest",
    taskId: task.id,
    watch: options.watch,
    prNumber: task.pullRequest.number ?? 0,
    url: task.pullRequest.url ?? "",
    status: task.status,
    mergeable: task.pullRequest.mergeable,
    requiredChecksSummary: summarizeRequiredChecks(task.pullRequest),
  };
}

export async function refreshTrackedPullRequest(paths: CraigPaths, taskId: string) {
  const task = await getTaskOrThrow(paths, taskId);

  if (!task.pullRequest.number) {
    return task;
  }

  await ensureGhAuthenticated(task.worktreePath);
  await refreshPullRequestState(paths, task);
  return task;
}
