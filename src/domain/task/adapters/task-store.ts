import { readFile } from "node:fs/promises";

import type { TaskRecord } from "../../../types/task.js";
import type { CraigPaths } from "../../../state/craig-paths.js";
import { atomicWriteJson } from "../../../state/atomic-write.js";
import { readCraigIndex, writeCraigIndex } from "../../../domain/workspace/adapters/index-store.js";
import { validateTaskRecord } from "../tasks/validate.js";

export const readRawTask = async (paths: CraigPaths, taskId: string): Promise<unknown> => {
  const raw = await readFile(getTaskFilePath(paths, taskId), "utf8");
  return JSON.parse(raw) as unknown;
};

export const readTask = async (paths: CraigPaths, taskId: string): Promise<TaskRecord> => {
  const raw = await readRawTask(paths, taskId);
  return validateTaskRecord(raw, getTaskFilePath(paths, taskId));
};

export const writeTask = async (paths: CraigPaths, task: TaskRecord): Promise<void> => {
  const normalized: TaskRecord = {
    ...task,
    updatedAt: new Date().toISOString(),
  };

  await atomicWriteJson(getTaskFilePath(paths, task.id), normalized);
};

export const appendTaskId = async (paths: CraigPaths, taskId: string): Promise<void> => {
  const index = await readCraigIndex(paths);

  if (index.taskIds.includes(taskId)) {
    return;
  }

  await writeCraigIndex(paths, {
    ...index,
    taskIds: [...index.taskIds, taskId],
  });
};

const getTaskFilePath = (paths: CraigPaths, taskId: string): string => {
  return `${paths.tasksDir}/${taskId}.json`;
};
