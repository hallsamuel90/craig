import { readFile } from "node:fs/promises";

import type { CommandListResult } from "../types/command.js";
import type { TaskRecord } from "../types/task.js";
import type { CraigPaths } from "../state/craig-paths.js";
import { readCraigIndex } from "../state/state-store.js";

export async function listTasks(paths: CraigPaths): Promise<CommandListResult> {
  const index = await readCraigIndex(paths);
  const tasks: TaskRecord[] = [];
  const missingTaskIds: string[] = [];

  await Promise.all(
    index.taskIds.map(async (taskId) => {
      try {
        const file = await readFile(`${paths.tasksDir}/${taskId}.json`, "utf8");
        tasks.push(JSON.parse(file) as TaskRecord);
      } catch (error) {
        if (isFileMissingError(error)) {
          missingTaskIds.push(taskId);
          return;
        }

        throw error;
      }
    }),
  );

  tasks.sort((left, right) => left.id.localeCompare(right.id));
  missingTaskIds.sort();

  return {
    kind: "listTasks",
    tasks,
    missingTaskIds,
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
