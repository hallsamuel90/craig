import { access } from "node:fs/promises";

import type { CraigPaths } from "../state/craig-paths.js";
import { writeTask } from "../state/task-store.js";
import type { TaskRecord } from "../types/task.js";
import { getTaskOrThrow } from "./task-inspection.js";

export async function closeTask(paths: CraigPaths, taskId: string): Promise<TaskRecord> {
  const task = await getTaskOrThrow(paths, taskId);

  if (task.status !== "merged") {
    throw new Error(`Task ${task.id} cannot close from status "${task.status}".`);
  }

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
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}
