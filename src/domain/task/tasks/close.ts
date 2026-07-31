import { access } from "node:fs/promises";

import type { CraigPaths } from "../../../state/craig-paths.js";
import { mutateTask } from "../adapters/task-store.js";
import type { TaskRecord } from "../types.js";
import { getTask } from "./inspect.js";

export const closeTask = async (paths: CraigPaths, taskId: string): Promise<TaskRecord> => {
  const task = await getTask(paths, taskId);
  const worktreeExists = await pathExists(task.worktreePath);

  return mutateTask(paths, taskId, (current): TaskRecord => ({
    ...current,
    status: "closed",
    cleanup: {
      ...current.cleanup,
      preservedWorktree: worktreeExists && current.cleanup.worktreeRemovedAt === null,
      warning: null,
    },
    lastFailureReason: null,
  }));
};

const pathExists = async (targetPath: string): Promise<boolean> => {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
};
