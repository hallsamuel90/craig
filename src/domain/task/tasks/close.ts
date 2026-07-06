import { access } from "node:fs/promises";

import type { CraigPaths } from "../../../state/craig-paths.js";
import { writeTask } from "../adapters/task-store.js";
import type { TaskRecord } from "../types.js";
import { getTask } from "./inspect.js";

export const closeTask = async (paths: CraigPaths, taskId: string): Promise<TaskRecord> => {
  const task = await getTask(paths, taskId);
  const worktreeExists = await pathExists(task.worktreePath);

  const closedTask: TaskRecord = {
    ...task,
    status: "closed",
    cleanup: {
      ...task.cleanup,
      preservedWorktree: worktreeExists && task.cleanup.worktreeRemovedAt === null,
      warning: null,
    },
    lastFailureReason: null,
  };

  await writeTask(paths, closedTask);
  return closedTask;
};

const pathExists = async (targetPath: string): Promise<boolean> => {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
};
