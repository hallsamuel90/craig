import type { CommandCommitResult } from "../types/command.js";
import type { CraigPaths } from "../state/craig-paths.js";
import { writeTask } from "../state/task-store.js";
import { commitAllChanges, getHeadCommit, hasUncommittedDiff, stageAllChanges } from "./git-task.js";
import { assertTaskWorktreeExists, getTaskOrThrow } from "./task-inspection.js";
import { deriveAggregateTaskStatus, getTaskWorktree, syncPrimaryReviewMirrors } from "./task-worktrees.js";

export async function commitTask(paths: CraigPaths, taskId: string, options: { repoId?: string } = {}): Promise<CommandCommitResult> {
  const task = await getTaskOrThrow(paths, taskId);
  const targetWorktrees = options.repoId ? [getTaskWorktree(task, options.repoId)] : task.worktrees;
  let committedHead: { sha: string; message: string } | null = null;

  for (const worktree of targetWorktrees) {
  await assertTaskWorktreeExists(task, worktree.repoId);

  const hadDiff = await hasUncommittedDiff(worktree.worktreePath);
  if (!hadDiff && !options.repoId) {
    continue;
  }

  if (task.status === "running" && hadDiff) {
    task.status = "review";
  }

  if (task.status !== "review" && task.status !== "checked") {
    throw new Error(`Task ${task.id} cannot commit from status "${task.status}".`);
  }

  if (!hadDiff) {
    throw new Error(`Task ${task.id} has no uncommitted diff to commit.`);
  }

  const message = task.prompt.value.trim();

  await stageAllChanges(worktree.worktreePath);
  await commitAllChanges(worktree.worktreePath, message);

  const head = await getHeadCommit(worktree.worktreePath);
  committedHead = head;
  const lastCommit = {
    sha: head.sha,
    message: head.message,
    committedAt: new Date().toISOString(),
  };
  task.repoReviews[worktree.repoId] = {
    ...(task.repoReviews[worktree.repoId] ?? {
      repoId: worktree.repoId,
      pullRequest: task.pullRequest,
      status: "not_changed" as const,
      updatedAt: new Date().toISOString(),
      lastFailureReason: null,
      lastCommit: null,
    }),
    lastCommit,
    status: "committed",
    lastFailureReason: null,
    updatedAt: new Date().toISOString(),
  };
  }
  if (!committedHead) {
    throw new Error(`Task ${task.id} has no uncommitted diff to commit.`);
  }
  task.status = deriveAggregateTaskStatus(task);
  task.lastFailureReason = null;

  await writeTask(paths, syncPrimaryReviewMirrors(task));

  return {
    kind: "commitTask",
    taskId: task.id,
    status: task.status,
    commitSha: committedHead.sha,
    message: committedHead.message,
  };
}
