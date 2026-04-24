import type { CommandListResult } from "../types/command.js";
import type { TaskRecord } from "../types/task.js";
import type { CraigPaths } from "../state/craig-paths.js";
import { readCraigIndex } from "../state/state-store.js";
import { readTask } from "../state/task-store.js";

export async function listTasks(paths: CraigPaths, options?: { repoId?: string }): Promise<CommandListResult> {
  const index = await readCraigIndex(paths);
  const tasks: TaskRecord[] = [];
  const missingTaskIds: string[] = [];

  await Promise.all(
    index.taskIds.map(async (taskId) => {
      try {
        tasks.push(await readTask(paths, taskId));
      } catch (error) {
        if (isFileMissingError(error)) {
          missingTaskIds.push(taskId);
          return;
        }

        throw error;
      }
    }),
  );

  const filteredTasks = options?.repoId ? tasks.filter((task) => task.repoId === options.repoId) : tasks;

  filteredTasks.sort((left, right) => left.id.localeCompare(right.id));
  missingTaskIds.sort();

  return {
    kind: "listTasks",
    tasks: filteredTasks,
    missingTaskIds,
    repoId: options?.repoId ?? null,
  };
}

function isFileMissingError(error: unknown): error is { code: string } {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    error.code === "ENOENT"
  );
}
