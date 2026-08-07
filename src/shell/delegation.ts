import { CraigError } from "../domain/error/index.js";
import { cancelTaskTree, type CommandCancelTreeResult } from "../domain/orchestration/index.js";
import { taskService } from "../domain/task/index.js";
import type { CraigPaths } from "../state/craig-paths.js";
import { disposeDaemonSessions } from "./pty-daemon-orchestration.js";

export async function cancelTaskTreeAndSessions(
  paths: CraigPaths,
  taskId: string,
  capabilityId?: string,
): Promise<CommandCancelTreeResult> {
  const tasks = (await taskService.listTasks(paths, { includeClosed: true })).tasks;
  const subtreeIds = new Set([taskId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const task of tasks) {
      if (task.parentTaskId && subtreeIds.has(task.parentTaskId) && !subtreeIds.has(task.id)) {
        subtreeIds.add(task.id);
        changed = true;
      }
    }
  }
  const tabIds = tasks
    .filter((task) => subtreeIds.has(task.id))
    .flatMap((task) => task.ptyTabs.map((tab) => tab.id));
  try {
    const result = await cancelTaskTree(paths, taskId, capabilityId);
    await disposeDaemonSessions(paths, tabIds);
    return result;
  } catch (error) {
    if (error instanceof CraigError && error.code === "PARTIAL_RESULT" && error.details.persisted === true) {
      await disposeDaemonSessions(paths, tabIds);
    }
    throw error;
  }
}
