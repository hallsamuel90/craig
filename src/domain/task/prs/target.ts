import type { ProjectTaskRepoTarget, TaskRecord } from "../types.js";
import type { CraigPaths } from "../../../state/craig-paths.js";
import { fetchPrView, discoverPrView } from "../adapters/github.js";
import { persistProjectPullRequestView } from "./project-persistence.js";

export const refreshOrDiscoverTargetPullRequest = async (
  paths: CraigPaths,
  task: TaskRecord,
  target: ProjectTaskRepoTarget,
): Promise<"synced" | "discovered" | "not_found"> => {
  const selector = target.pullRequest.number ? String(target.pullRequest.number) : target.branch;
  if (target.pullRequest.number) {
    const view = await fetchPrView(selector, target.worktreePath);
    await persistProjectPullRequestView(paths, task.id, target.repoId, view);
    return "synced";
  }
  const view = await discoverPrView(selector, target.worktreePath);
  if (!view) {
    return "not_found";
  }
  await persistProjectPullRequestView(paths, task.id, target.repoId, view);
  return "discovered";
};
