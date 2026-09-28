import type { ProjectTaskRepoTarget, TaskRecord } from "../types.js";
import type { CraigPaths } from "../../../state/craig-paths.js";
import { fetchPrView, discoverPrView } from "../adapters/github.js";
import {
  clearMismatchedProjectPullRequest,
  hasBranchMatchingPullRequest,
  persistProjectPullRequestView,
} from "./project-persistence.js";

export const refreshOrDiscoverTargetPullRequest = async (
  paths: CraigPaths,
  task: TaskRecord,
  target: ProjectTaskRepoTarget,
): Promise<"synced" | "discovered" | "not_found"> => {
  if (hasBranchMatchingPullRequest(target)) {
    const selector = String(target.pullRequest.number);
    const view = await fetchPrView(selector, target.worktreePath);
    await persistProjectPullRequestView(paths, task.id, target.repoId, view);
    return "synced";
  }
  const view = await discoverPrView(target.branch, target.worktreePath);
  if (!view) {
    await clearMismatchedProjectPullRequest(paths, task.id, target.repoId);
    return "not_found";
  }
  await persistProjectPullRequestView(paths, task.id, target.repoId, view);
  return "discovered";
};
