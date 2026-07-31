import type { CraigPaths } from "../../../state/craig-paths.js";
import { parseGitHubPullRequestUrl, type GhPrView } from "../adapters/github.js";
import { withTaskLock } from "../adapters/task-lock.js";
import { getTask } from "../tasks/inspect.js";
import type { TaskPullRequest, TaskRecord } from "../types.js";
import { isSamePullRequest, normalizePr, normalizeRequiredChecks, upsertTaskPr } from "./state.js";
import { persistTaskAndPrStatus } from "./refresh.js";

export async function persistProjectPullRequestView(
  paths: CraigPaths,
  taskId: string,
  repoId: string,
  view: GhPrView,
): Promise<TaskRecord> {
  return withTaskLock(paths, taskId, async () => {
    const task = await getTask(paths, taskId);
    const target = task.repoTargets?.find((candidate) => candidate.repoId === repoId);
    if (!target) {
      throw new Error(`Project task ${taskId} has no repo target ${repoId}.`);
    }

    const repository = parseGitHubPullRequestUrl(view.url);
    const existing = task.prs.find((pr) =>
      repository
        ? isSamePullRequest(pr, {
            owner: repository.owner,
            repo: repository.name,
            number: view.number,
          })
        : pr.number === view.number
    ) ?? null;
    const historyPr = normalizePr(view, existing, repository ?? undefined);
    const pullRequest = normalizeProjectPullRequest(view);
    const withHistory = upsertTaskPr(task, historyPr);
    const nextTask: TaskRecord = {
      ...withHistory,
      repoTargets: (withHistory.repoTargets ?? []).map((candidate) =>
        candidate.repoId === repoId ? { ...candidate, pullRequest } : candidate
      ),
    };
    const persisted = {
      ...nextTask,
      status: nextTask.status === "closed" ? nextTask.status : deriveProjectTaskStatus(nextTask),
    };
    return persistTaskAndPrStatus(paths, persisted);
  });
}

export function normalizeProjectPullRequest(view: GhPrView): TaskPullRequest {
  const repository = parseGitHubPullRequestUrl(view.url);
  return {
    provider: "github",
    owner: repository?.owner ?? null,
    repo: repository?.name ?? null,
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
}

export function deriveProjectTaskStatus(task: TaskRecord): TaskRecord["status"] {
  const readyTargets = (task.repoTargets ?? []).filter((target) => target.status === "ready");
  const pullRequests = readyTargets
    .map((target) => target.pullRequest)
    .filter((pullRequest) => pullRequest.number !== null);
  if (pullRequests.length === 0) {
    return "checked";
  }
  if (pullRequests.every((pullRequest) => pullRequest.status === "merged")) {
    return "merged";
  }
  if (
    pullRequests.length === readyTargets.length &&
    pullRequests.every((pullRequest) =>
      pullRequest.mergeable &&
      pullRequest.reviewDecision !== "REVIEW_REQUIRED" &&
      pullRequest.reviewDecision !== "CHANGES_REQUESTED" &&
      pullRequest.mergeStateStatus !== "REVIEW_REQUIRED" &&
      pullRequest.requiredChecks.length > 0 &&
      pullRequest.requiredChecks.every((check) => check.status === "success" || check.status === "skipped")
    )
  ) {
    return "merge_ready";
  }
  if (pullRequests.some((pullRequest) => pullRequest.status === "open")) {
    return "pr_open";
  }
  return "checked";
}

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
