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

export async function mergeTask(
  paths: CraigPaths,
  taskId: string,
  options: { preserveWorktree: boolean },
): Promise<CommandMergeResult> {
  const task = await getTaskOrThrow(paths, taskId);
  await assertTaskWorktreeExists(task);

  if (task.status !== "pr_open" && task.status !== "merge_ready") {
    throw new Error(`Task ${task.id} cannot merge from status "${task.status}".`);
  }

  if (!task.pullRequest.number) {
    throw new Error(`Task ${task.id} does not have a tracked pull request.`);
  }

  if (!task.lastCommit) {
    throw new Error(`Task ${task.id} must be committed before merging.`);
  }

  if (!(await isWorktreeClean(task.worktreePath))) {
    throw new Error(`Task ${task.id} worktree must be clean before merging.`);
  }

  const headCommit = await getHeadCommit(task.worktreePath);
  if (headCommit.sha !== task.lastCommit.sha) {
    throw new Error(`Task ${task.id} local HEAD does not match the tracked task commit. Sync or commit before merging.`);
  }

  await ensureGhAuthenticated(task.worktreePath);
  await refreshPullRequestState(paths, task);

  const blockers = getMergeBlockers(task);
  if (blockers.length > 0) {
    throw new Error(`Task ${task.id} pull request is not merge-ready: ${blockers.join("; ")}.`);
  }

  const config = await readCraigConfig(paths);
  const mergeMethod = config.github?.mergeMethod ?? "squash";

  await mergeGitHubPullRequest(task, mergeMethod);

  task.pullRequest.status = "merged";
  task.status = "merged";
  task.lastFailureReason = null;
  await writeTask(paths, task);

  await cleanupTask(paths, task, options);

  return {
    kind: "mergeTask",
    taskId: task.id,
    status: task.status,
    prNumber: task.pullRequest.number,
    preservedWorktree: options.preserveWorktree,
    cleanupWarning: task.cleanup.warning,
  };
}

function getMergeBlockers(task: TaskRecord): string[] {
  const blockers: string[] = [];
  const pr = task.pullRequest;

  if (pr.status !== "open") {
    blockers.push(`PR is ${pr.status ?? "unknown"}`);
  }

  if (!pr.mergeable) {
    blockers.push(`GitHub reports merge state ${pr.mergeStateStatus ?? "unknown"}`);
  }

  if (pr.lastSyncedHeadSha !== task.lastCommit?.sha) {
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
