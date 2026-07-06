import type { CommandCommitResult } from "../../../commands/types.js";
import type { CraigPaths } from "../../../state/craig-paths.js";
import { writeTask } from "../adapters/task-store.js";
import { commitAllChanges, getHeadCommit, hasUncommittedDiff, stageAllChanges } from "../adapters/git.js";
import { assertTaskWorktreeExists, getTask } from "./inspect.js";

export const commitTask = async (paths: CraigPaths, taskId: string): Promise<CommandCommitResult> => {
  const task = await getTask(paths, taskId);
  await assertTaskWorktreeExists(task);

  const hadDiff = await hasUncommittedDiff(task.worktreePath);

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

  await stageAllChanges(task.worktreePath);
  await commitAllChanges(task.worktreePath, message);

  const head = await getHeadCommit(task.worktreePath);
  task.lastCommit = {
    sha: head.sha,
    message: head.message,
    committedAt: new Date().toISOString(),
  };
  task.lastFailureReason = null;

  await writeTask(paths, task);

  return {
    kind: "commitTask",
    taskId: task.id,
    status: task.status,
    commitSha: head.sha,
    message: head.message,
  };
};
