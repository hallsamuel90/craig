import type { CommandShowTaskResult } from "../types/command.js";
import type { CraigPaths } from "../state/craig-paths.js";
import { buildTaskInspection, getTaskOrThrow } from "./task-inspection.js";
import { refreshTrackedPullRequest } from "./open-pull-request.js";

export async function showTask(paths: CraigPaths, taskId: string): Promise<CommandShowTaskResult> {
  let task = await getTaskOrThrow(paths, taskId);

  if (task.pullRequest.number) {
    try {
      task = await refreshTrackedPullRequest(paths, taskId);
    } catch {
      // Keep show resilient when GitHub is unavailable; persisted task state is still useful.
    }
  }

  const inspection = await buildTaskInspection(paths, task);

  return {
    kind: "showTask",
    task,
    inspection,
  };
}
