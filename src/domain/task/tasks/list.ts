import type { CommandListResult } from "../types.js";
import type { TaskRecord } from "../types.js";
import type { CraigPaths } from "../../../state/craig-paths.js";
import { readCraigIndex } from "../../../domain/workspace/index.js";
import { readRawTask } from "../adapters/task-store.js";
import { validateTaskRecord } from "./validate.js";

export const listTasks = async (
  paths: CraigPaths,
  options?: { repoId?: string; workspaceId?: string; includeClosed?: boolean },
  deps: { readRawTask: typeof readRawTask; validateTaskRecord: typeof validateTaskRecord } = { readRawTask, validateTaskRecord },
): Promise<CommandListResult> => {
  const index = await readCraigIndex(paths);
  const tasks: TaskRecord[] = [];
  const missingTaskIds: string[] = [];

  await Promise.all(
    index.taskIds.map(async (taskId) => {
      try {
        const raw = await deps.readRawTask(paths, taskId);
        tasks.push(deps.validateTaskRecord(raw, `${paths.tasksDir}/${taskId}.json`));
      } catch (error) {
        if (isFileMissingError(error)) {
          missingTaskIds.push(taskId);
          return;
        }

        throw error;
      }
    }),
  );

  const activeTasks = options?.includeClosed ? tasks : tasks.filter((task) => task.status !== "closed");
  const filteredTasks = activeTasks.filter((task) => {
    if (options?.workspaceId && task.workspaceId !== options.workspaceId) {
      return false;
    }

    if (options?.repoId && task.repoId !== options.repoId && !(task.repoTargets ?? []).some((target) => target.repoId === options.repoId)) {
      return false;
    }

    return true;
  });

  filteredTasks.sort((left, right) => left.id.localeCompare(right.id));
  missingTaskIds.sort();

  return {
    kind: "listTasks",
    tasks: filteredTasks,
    missingTaskIds,
    repoId: options?.repoId ?? null,
  };
};

const isFileMissingError = (error: unknown): error is { code: string } => {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof (error as { code?: unknown }).code === "string" &&
    (error as { code: string }).code === "ENOENT"
  );
};
