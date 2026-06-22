import type { CommandListResult } from "../types/command.js";
import type { TaskRecord } from "../types/task.js";
import type { CraigPaths } from "../state/craig-paths.js";
import { readCraigIndex } from "../domain/workspace/adapters/index-store.js";
import { readTask } from "../state/task-store.js";

export async function listTasks(
  paths: CraigPaths,
  options?: { repoId?: string; workspaceId?: string; includeClosed?: boolean },
): Promise<CommandListResult> {
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
