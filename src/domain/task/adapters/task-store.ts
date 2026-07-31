import { readFile } from "node:fs/promises";

import type { TaskRecord } from "../types.js";
import type { CraigPaths } from "../../../state/craig-paths.js";
import { atomicWriteJson } from "../../../shared/atomic-write.js";
import { readCraigIndex, writeCraigIndex } from "../../../domain/workspace/index.js";
import { validateTaskRecord } from "../tasks/validate.js";
import { withTaskLock } from "./task-lock.js";

export const readRawTask = async (paths: CraigPaths, taskId: string): Promise<unknown> => {
  const raw = await readFile(getTaskFilePath(paths, taskId), "utf8");
  return JSON.parse(raw) as unknown;
};

export const readTask = async (paths: CraigPaths, taskId: string): Promise<TaskRecord> => {
  const raw = await readRawTask(paths, taskId);
  return validateTaskRecord(raw, getTaskFilePath(paths, taskId));
};

export const writeTask = async (paths: CraigPaths, task: TaskRecord): Promise<void> => {
  const normalized = normalizeTaskForWrite(task);
  await atomicWriteJson(getTaskFilePath(paths, task.id), normalized);
};

export const mutateTask = async (
  paths: CraigPaths,
  taskId: string,
  /* eslint-disable-next-line no-unused-vars */
  mutation: (_task: TaskRecord) => TaskRecord | Promise<TaskRecord>,
): Promise<TaskRecord> => {
  return withTaskLock(paths, taskId, async () => {
    const current = await readTask(paths, taskId);
    const mutated = await mutation(current);
    if (mutated.id !== taskId) {
      throw new Error(`Task mutation cannot change task id ${taskId} to ${mutated.id}.`);
    }
    const normalized = normalizeTaskForWrite(mutated);
    await atomicWriteJson(getTaskFilePath(paths, taskId), normalized);
    return normalized;
  });
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

const normalizeTaskForWrite = (task: TaskRecord): TaskRecord => ({
  ...task,
  updatedAt: new Date().toISOString(),
});
