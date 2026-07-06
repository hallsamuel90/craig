import type { TaskPullRequest, TaskRecord } from "../types.js";
import type { CraigPaths } from "../../../state/craig-paths.js";
import { readRawTask, writeTask } from "../adapters/task-store.js";
import { validateTaskRecord } from "../tasks/validate.js";
import {
  discoverPullRequestState,
  refreshPullRequestState,
  writePrStatusArtifact,
  persistPullRequestView,
} from "./refresh.js";
import {
  ensureGhAuthenticated,
  fetchPullRequestViewsBatch,
  getGitHubRepositoryLocator,
  type GitHubRepositoryLocator,
} from "../adapters/github.js";
import { assertTaskWorktreeExists, getTask } from "../tasks/inspect.js";
import { getTaskPrimaryPr, isPrTerminal, normalizeRequiredChecks } from "./state.js";
import { refreshOrDiscoverTargetPullRequest } from "./target.js";

export type PullRequestSyncDisposition = "discovered" | "synced" | "not_found";

export interface PullRequestPollResult {
  taskId: string;
  synced: number;
  discovered: number;
  notFound: number;
  hadPr: boolean;
  firstDiscoveredPrNumber: number | null;
  firstDiscoveredPrUrl: string | null;
}

export const refreshTrackedPullRequest = async (paths: CraigPaths, taskId: string) => {
  const task = await getTask(paths, taskId);
  const primaryPr = getTaskPrimaryPr(task);

  if (!primaryPr?.number) {
    return task;
  }

  await ensureGhAuthenticated(task.worktreePath);

  if (isPrTerminal(primaryPr)) {
    const discovered = await discoverPullRequestState(paths, task);
    return discovered.task;
  }

  return refreshPullRequestState(paths, task);
};

export const refreshPullRequestChecks = async (paths: CraigPaths, taskId: string) => {
  const task = await getTask(paths, taskId);

  if (task.type === "project" && task.repoTargets?.length) {
    await discoverOrRefreshAllProjectPullRequests(paths, taskId);
    return getTask(paths, taskId);
  }

  const primaryPr = getTaskPrimaryPr(task);
  await assertTaskWorktreeExists(task);
  await ensureGhAuthenticated(task.worktreePath);

  if (!primaryPr?.number || isPrTerminal(primaryPr)) {
    const discovered = await discoverPullRequestState(paths, task);
    if (!discovered.discovered && !primaryPr?.number) {
      throw new Error(`No PR found for ${task.branch}.`);
    }
    await writePrStatusArtifact(paths, discovered.task);
    return discovered.task;
  }

  const refreshed = await refreshPullRequestState(paths, task);
  await writePrStatusArtifact(paths, refreshed);
  return refreshed;
};

export const discoverOrRefreshAllProjectPullRequests = async (
  paths: CraigPaths,
  taskId: string,
): Promise<{ synced: number; discovered: number; notFound: number }> => {
  const task = await getTask(paths, taskId);
  const targets = (task.repoTargets ?? []).filter((t) => t.status === "ready");

  const counts = { synced: 0, discovered: 0, notFound: 0 };
  for (const target of targets) {
    await ensureGhAuthenticated(target.worktreePath);
    const disposition = target.pullRequest.number
      ? await refreshOrDiscoverTargetPullRequest(paths, task, target)
      : await refreshOrDiscoverTargetPullRequest(paths, task, target).catch(() => "not_found" as const);
    counts[disposition === "not_found" ? "notFound" : disposition]++;
  }
  const raw = await readRawTask(paths, task.id);
  const latestTask = validateTaskRecord(raw, `${paths.tasksDir}/${task.id}.json`);
  if (latestTask.status !== "closed") {
    latestTask.status = deriveProjectTaskStatus(latestTask);
    await writeTask(paths, latestTask);
  }
  return counts;
};

export const discoverOrRefreshPullRequests = async (
  paths: CraigPaths,
  tasks: TaskRecord[],
): Promise<PullRequestPollResult[]> => {
  const results = new Map<string, PullRequestPollResult>();
  const batchGroups = new Map<string, PullRequestBatchGroup>();

  for (const task of tasks) {
    const result = ensurePollResult(results, task);
    if (task.type === "project" && task.repoTargets?.length) {
      for (const target of task.repoTargets.filter((entry) => entry.status === "ready")) {
        const item: PullRequestBatchItem = {
          id: `${task.id}:${target.repoId}`,
          task,
          targetRepoId: target.repoId,
          worktreePath: target.worktreePath,
          selector: target.pullRequest.number ? String(target.pullRequest.number) : target.branch,
          mode: target.pullRequest.number ? "number" : "head",
        };
        await enqueueBatchItem(batchGroups, item).catch(async () => {
          try {
            const disposition = target.pullRequest.number
              ? await refreshOrDiscoverTargetPullRequest(paths, task, target)
              : await refreshOrDiscoverTargetPullRequest(paths, task, target).catch(() => "not_found" as const);
            recordDisposition(result, disposition, target.pullRequest.number ?? null, target.pullRequest.url ?? null);
          } catch {
            // Background fallback refresh remains best-effort.
          }
        });
      }
      continue;
    }

    const taskPrimaryPr = getTaskPrimaryPr(task);
    const pollByNumber = taskPrimaryPr?.number && !isPrTerminal(taskPrimaryPr);
    const item: PullRequestBatchItem = {
      id: task.id,
      task,
      worktreePath: task.worktreePath,
      selector: pollByNumber ? String(taskPrimaryPr!.number) : task.branch,
      mode: pollByNumber ? "number" : "head",
    };
    await enqueueBatchItem(batchGroups, item).catch(async () => {
      try {
        const { disposition, task: refreshedTask } = await discoverOrRefreshPullRequest(paths, task.id);
        const refreshedPrimaryPr = getTaskPrimaryPr(refreshedTask);
        recordDisposition(result, disposition, refreshedPrimaryPr?.number ?? null, refreshedPrimaryPr?.url ?? null);
      } catch {
        // Background fallback refresh remains best-effort.
      }
    });
  }

  for (const group of batchGroups.values()) {
    try {
      await ensureGhAuthenticated(group.worktreePath);
      const batchResults = await fetchPullRequestViewsBatch(group.worktreePath, group.repository, group.items);
      const byId = new Map(batchResults.map((result) => [result.id, result]));

      for (const item of group.items) {
        const result = ensurePollResult(results, item.task);
        const batchResult = byId.get(item.id);
        if (!batchResult?.found || !batchResult.view) {
          recordDisposition(result, "not_found", null, null);
          continue;
        }

        if (item.targetRepoId) {
          const raw = await readRawTask(paths, item.task.id);
          const latestTask = validateTaskRecord(raw, `${paths.tasksDir}/${item.task.id}.json`);
          await persistTargetPullRequestView(paths, latestTask, item.targetRepoId, batchResult.view);
        } else {
          const raw = await readRawTask(paths, item.task.id);
          const latestTask = validateTaskRecord(raw, `${paths.tasksDir}/${item.task.id}.json`);
          await persistPullRequestView(paths, latestTask, batchResult.view, getTaskPrimaryPr(latestTask));
        }

        recordDisposition(
          result,
          item.mode === "number" ? "synced" : "discovered",
          batchResult.view.number,
          batchResult.view.url,
        );
      }
    } catch {
      // Background polling is best-effort; manual refresh keeps surfacing actionable errors.
    }
  }

  for (const task of tasks.filter((entry) => entry.type === "project" && entry.repoTargets?.length)) {
    const raw = await readRawTask(paths, task.id);
    const latestTask = validateTaskRecord(raw, `${paths.tasksDir}/${task.id}.json`);
    if (latestTask.status !== "closed") {
      latestTask.status = deriveProjectTaskStatus(latestTask);
      await writeTask(paths, latestTask);
    }
  }

  return tasks.map((task) => ensurePollResult(results, task));
};

export const discoverOrRefreshPullRequest = async (
  paths: CraigPaths,
  taskId: string,
): Promise<{ disposition: PullRequestSyncDisposition; task: Awaited<ReturnType<typeof getTask>> }> => {
  const task = await getTask(paths, taskId);
  await assertTaskWorktreeExists(task);
  await ensureGhAuthenticated(task.worktreePath);

  const primaryPr = getTaskPrimaryPr(task);
  if (primaryPr?.number && !isPrTerminal(primaryPr)) {
    const refreshed = await refreshPullRequestState(paths, task);
    return { disposition: "synced", task: refreshed };
  }

  const discovered = await discoverPullRequestState(paths, task);
  return { disposition: discovered.discovered ? "discovered" : "not_found", task: discovered.task };
};

const deriveProjectTaskStatus = (task: TaskRecord): TaskRecord["status"] => {
  const readyTargets = (task.repoTargets ?? []).filter((target) => target.status === "ready");
  const prs = readyTargets.map((target) => target.pullRequest).filter((pr) => Boolean(pr.number));

  if (prs.length === 0) {
    return task.status;
  }
  if (prs.every((pr) => pr.status === "merged")) {
    return "merged";
  }
  if (prs.length === readyTargets.length && prs.every(isProjectTargetMergeReady)) {
    return "merge_ready";
  }
  if (prs.some((pr) => pr.status === "open")) {
    return "pr_open";
  }
  return "checked";
};

const persistTargetPullRequestView = async (
  paths: CraigPaths,
  task: TaskRecord,
  repoId: string,
  view: { number: number; url: string; baseRefName: string; headRefName: string; headRefOid?: string | null; state: string; isDraft?: boolean; mergeable: string; mergeStateStatus: string | null; title?: string | null; createdAt?: string | null; updatedAt?: string | null; mergedAt?: string | null; reviewDecision?: string | null; statusCheckRollup: unknown[]; comments?: unknown[] | { nodes?: unknown[] | null } | null },
): Promise<TaskRecord> => {
  const pullRequest = normalizePullRequest(view);
  const repoTargets = (task.repoTargets ?? []).map((target) =>
    target.repoId === repoId ? { ...target, pullRequest } : target,
  );
  const nextTask: TaskRecord = {
    ...task,
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

interface PullRequestBatchItem {
  id: string;
  task: TaskRecord;
  targetRepoId?: string;
  worktreePath: string;
  selector: string;
  mode: "number" | "head";
}

interface PullRequestBatchGroup {
  worktreePath: string;
  repository: GitHubRepositoryLocator;
  items: PullRequestBatchItem[];
}

const enqueueBatchItem = async (
  groups: Map<string, PullRequestBatchGroup>,
  item: PullRequestBatchItem,
): Promise<void> => {
  const repository = await getGitHubRepositoryLocator(item.worktreePath);
  if (!repository) {
    throw new Error("GitHub repository remote could not be parsed.");
  }

  const key = `${repository.owner}/${repository.name}`;
  const existing = groups.get(key);
  if (existing) {
    existing.items.push(item);
    return;
  }

  groups.set(key, {
    worktreePath: item.worktreePath,
    repository,
    items: [item],
  });
};

const ensurePollResult = (
  results: Map<string, PullRequestPollResult>,
  task: TaskRecord,
): PullRequestPollResult => {
  const existing = results.get(task.id);
  if (existing) {
    return existing;
  }

  const result = {
    taskId: task.id,
    synced: 0,
    discovered: 0,
    notFound: 0,
    hadPr: task.type === "project"
      ? Boolean(task.repoTargets?.some((target) => target.pullRequest.number))
      : Boolean(getTaskPrimaryPr(task)?.number),
    firstDiscoveredPrNumber: null,
    firstDiscoveredPrUrl: null,
  };
  results.set(task.id, result);
  return result;
};

const recordDisposition = (
  result: PullRequestPollResult,
  disposition: PullRequestSyncDisposition,
  prNumber: number | null,
  prUrl: string | null,
): void => {
  if (disposition === "synced") {
    result.synced += 1;
    return;
  }

  if (disposition === "discovered") {
    result.discovered += 1;
    result.firstDiscoveredPrNumber ??= prNumber;
    result.firstDiscoveredPrUrl ??= prUrl;
    return;
  }

  result.notFound += 1;
};

const isProjectTargetMergeReady = (pullRequest: TaskPullRequest): boolean => {
  return (
    pullRequest.mergeable &&
    pullRequest.reviewDecision !== "REVIEW_REQUIRED" &&
    pullRequest.reviewDecision !== "CHANGES_REQUESTED" &&
    pullRequest.mergeStateStatus !== "REVIEW_REQUIRED" &&
    pullRequest.requiredChecks.length > 0 &&
    pullRequest.requiredChecks.every((check) => check.status === "success" || check.status === "skipped")
  );
};
