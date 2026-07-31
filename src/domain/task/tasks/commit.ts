import type { CommandCommitResult } from "../types.js";
import type { CraigPaths } from "../../../state/craig-paths.js";
import { mutateTask } from "../adapters/task-store.js";
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
  const committedAt = new Date().toISOString();
  const updated = await mutateTask(paths, task.id, (current) => ({
    ...current,
    status: current.status === "running" ? task.status : current.status,
    lastCommit: {
      sha: head.sha,
      message: head.message,
      committedAt,
    },
    lastFailureReason: null,
  }));

  return {
    kind: "commitTask",
    taskId: task.id,
    status: updated.status,
    commitSha: head.sha,
    message: head.message,
  };
};
