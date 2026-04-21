import type { CommandShowTaskResult } from "../types/command.js";
import type { CraigPaths } from "../state/craig-paths.js";
import { buildTaskInspection, getTaskOrThrow } from "./task-inspection.js";

export async function showTask(paths: CraigPaths, taskId: string): Promise<CommandShowTaskResult> {
  const task = await getTaskOrThrow(paths, taskId);
  const inspection = await buildTaskInspection(paths, task);

  return {
    kind: "showTask",
    task,
    inspection,
  };
}
