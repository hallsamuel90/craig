import type { CommandMergeResult } from "../types/command.js";
import type { CraigPaths } from "../state/craig-paths.js";
import { readCraigConfig } from "../state/config-store.js";
import { writeTask } from "../state/task-store.js";
import { cleanupTask } from "./cleanup-task.js";
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

  await ensureGhAuthenticated(task.worktreePath);
  await refreshPullRequestState(paths, task);

  if (!isMergeReady(task.pullRequest)) {
    throw new Error(`Task ${task.id} pull request is not merge-ready.`);
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
