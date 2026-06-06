import type { CommandShowTaskResult } from "../types/command.js";
import type { CraigPaths } from "../state/craig-paths.js";
import { readSession } from "../state/session-store.js";
import { buildTaskInspection, getTaskOrThrow } from "./task-inspection.js";
import { discoverOrRefreshAllProjectPullRequests, refreshTrackedPullRequest } from "./open-pull-request.js";

export async function showTask(paths: CraigPaths, taskId: string): Promise<CommandShowTaskResult> {
  let task = await getTaskOrThrow(paths, taskId);

  try {
    if (task.type === "project" && task.repoTargets?.length) {
      await discoverOrRefreshAllProjectPullRequests(paths, taskId);
      task = await getTaskOrThrow(paths, taskId);
    } else if (task.prs.some((pr) => pr.number)) {
      task = await refreshTrackedPullRequest(paths, taskId);
    }
  } catch {
    // Keep show resilient when GitHub is unavailable; persisted task state is still useful.
  }

  const inspection = await buildTaskInspection(paths, task);
  const session = task.sessionId ? await readSession(paths, task.sessionId).catch(() => null) : null;

  return {
    kind: "showTask",
    task,
    inspection,
    session,
  };
}
