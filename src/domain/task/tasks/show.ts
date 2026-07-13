import type { CommandShowTaskResult } from "../types.js";
import type { CraigPaths } from "../../../state/craig-paths.js";
import { readSession } from "../adapters/session.js";
import { buildTaskInspection, getTask } from "./inspect.js";
import { discoverOrRefreshAllProjectPullRequests, refreshTrackedPullRequest } from "../prs/open.js";

export const showTask = async (paths: CraigPaths, taskId: string): Promise<CommandShowTaskResult> => {
  let task = await getTask(paths, taskId);

  try {
    if (task.type === "project" && task.repoTargets?.length) {
      await discoverOrRefreshAllProjectPullRequests(paths, taskId);
      task = await getTask(paths, taskId);
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
};
