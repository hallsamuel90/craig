import type { ProjectTaskRepoTarget, TaskPullRequest, TaskRecord } from "../../../types/task.js";
import type { CraigPaths } from "../../../state/craig-paths.js";
import { readRawTask, writeTask } from "../adapters/task-store.js";
import { validateTaskRecord } from "../tasks/validate.js";
import { fetchPrView, discoverPrView } from "../adapters/github.js";
import { normalizeRequiredChecks } from "./state.js";

export const refreshOrDiscoverTargetPullRequest = async (
  paths: CraigPaths,
  task: TaskRecord,
  target: ProjectTaskRepoTarget,
): Promise<"synced" | "discovered" | "not_found"> => {
  const selector = target.pullRequest.number ? String(target.pullRequest.number) : target.branch;
  if (target.pullRequest.number) {
    const view = await fetchPrView(selector, target.worktreePath);
    const pullRequest = normalizePullRequest(view);
    target.pullRequest = pullRequest;
    await persistProjectTargetPullRequest(paths, task, target.repoId, pullRequest);
    return "synced";
  }
  const view = await discoverPrView(selector, target.worktreePath);
  if (!view) {
    return "not_found";
  }
  const pullRequest = normalizePullRequest(view);
  target.pullRequest = pullRequest;
  await persistProjectTargetPullRequest(paths, task, target.repoId, pullRequest);
  return "discovered";
};

const persistProjectTargetPullRequest = async (
  paths: CraigPaths,
  task: TaskRecord,
  repoId: string,
  pullRequest: TaskPullRequest,
): Promise<TaskRecord> => {
  const raw = await readRawTask(paths, task.id);
  const latest = validateTaskRecord(raw, `${paths.tasksDir}/${task.id}.json`);
  const repoTargets = (latest.repoTargets ?? task.repoTargets ?? []).map((target) =>
    target.repoId === repoId ? { ...target, pullRequest } : target,
  );
  const nextTask: TaskRecord = {
    ...latest,
    repoTargets,
  };

  await writeTask(paths, nextTask);
  return nextTask;
};

const normalizePullRequest = (view: { number: number; url: string; baseRefName: string; headRefName: string; headRefOid?: string | null; state: string; isDraft?: boolean; mergeable: string; mergeStateStatus: string | null; reviewDecision?: string | null; statusCheckRollup: unknown[]; comments?: unknown[] | { nodes?: unknown[] | null } | null }): TaskPullRequest => {
  return {
    provider: "github",
    number: view.number,
    url: view.url,
    baseBranch: view.baseRefName,
    headBranch: view.headRefName,
    status: normalizePrState(view.state),
    draft: view.isDraft ?? false,
    mergeable: view.mergeable === "MERGEABLE",
    mergeStateStatus: view.mergeStateStatus,
    reviewDecision: normalizeReviewDecision(view.reviewDecision ?? null),
    requiredChecks: normalizeRequiredChecks(view.statusCheckRollup),
    comments: [],
    lastSyncedAt: new Date().toISOString(),
    lastSyncedHeadSha: view.headRefOid ?? null,
  };
};

const normalizePrState = (state: string): TaskPullRequest["status"] => {
  if (state === "OPEN") return "open";
  if (state === "MERGED") return "merged";
  if (state === "CLOSED") return "closed";
  return null;
};

const normalizeReviewDecision = (value: string | null) => {
  if (value === "APPROVED" || value === "CHANGES_REQUESTED" || value === "REVIEW_REQUIRED") {
    return value as "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED";
  }
  return null;
};
