import type { TaskRecord } from "../types.js";
import type { CraigPaths } from "../../../state/craig-paths.js";
import { readRawTask } from "../adapters/task-store.js";
import { validateTaskRecord } from "../tasks/validate.js";
import {
  discoverPullRequestState,
  refreshPullRequestState,
  persistPullRequestView,
  getPullRequestDiscoveryBranches,
} from "./refresh.js";
import {
  ensureGhAuthenticated,
  discoverPrView,
  fetchPullRequestViewsBatch,
  getGitHubRepositoryLocator,
  type GitHubRepositoryLocator,
} from "../adapters/github.js";
import { GitHubRateLimitError } from "./errors.js";
import { assertTaskWorktreeExists, getTask } from "../tasks/inspect.js";
import { getTaskPrimaryPr, isPrTerminal } from "./state.js";
import { refreshOrDiscoverTargetPullRequest } from "./target.js";
import { persistProjectPullRequestView } from "./project-persistence.js";

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
    return discovered.task;
  }

  const refreshed = await refreshPullRequestState(paths, task);
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
  return counts;
};

export const discoverOrRefreshPullRequests = async (
  paths: CraigPaths,
  tasks: TaskRecord[],
): Promise<PullRequestPollResult[]> => {
  const results = new Map<string, PullRequestPollResult>();
  const batchGroups = new Map<string, PullRequestBatchGroup>();
  const failures: unknown[] = [];

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
          fallbackSelectors: [],
        };
        await enqueueBatchItem(batchGroups, item).catch(async () => {
          try {
            await ensureGhAuthenticated(target.worktreePath);
            const disposition = target.pullRequest.number
              ? await refreshOrDiscoverTargetPullRequest(paths, task, target)
              : await refreshOrDiscoverTargetPullRequest(paths, task, target);
            recordDisposition(result, disposition, target.pullRequest.number ?? null, target.pullRequest.url ?? null);
          } catch (error) {
            if (error instanceof GitHubRateLimitError) throw error;
            failures.push(error);
          }
        });
      }
      continue;
    }

    const taskPrimaryPr = getTaskPrimaryPr(task);
    const pollByNumber = taskPrimaryPr?.number && !isPrTerminal(taskPrimaryPr);
    const discoveryBranches = pollByNumber ? [] : await getPullRequestDiscoveryBranches(task);
    const item: PullRequestBatchItem = {
      id: task.id,
      task,
      worktreePath: task.worktreePath,
      selector: pollByNumber ? String(taskPrimaryPr!.number) : discoveryBranches[0] ?? task.branch,
      mode: pollByNumber ? "number" : "head",
      fallbackSelectors: pollByNumber ? [] : discoveryBranches.slice(1),
    };
    await enqueueBatchItem(batchGroups, item).catch(async () => {
      try {
        const { disposition, task: refreshedTask } = await discoverOrRefreshPullRequest(paths, task.id);
        const refreshedPrimaryPr = getTaskPrimaryPr(refreshedTask);
        recordDisposition(result, disposition, refreshedPrimaryPr?.number ?? null, refreshedPrimaryPr?.url ?? null);
      } catch (error) {
        if (error instanceof GitHubRateLimitError) throw error;
        failures.push(error);
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
        const view = batchResult?.view ?? await fetchFirstFallbackPullRequestView(group.worktreePath, item);
        if (!view) {
          recordDisposition(result, "not_found", null, null);
          continue;
        }

        if (item.targetRepoId) {
          await persistProjectPullRequestView(paths, item.task.id, item.targetRepoId, view);
        } else {
          const raw = await readRawTask(paths, item.task.id);
          const latestTask = validateTaskRecord(raw, `${paths.tasksDir}/${item.task.id}.json`);
          await persistPullRequestView(paths, latestTask, view, item.mode === "number" ? getTaskPrimaryPr(latestTask) : null);
        }

        recordDisposition(
          result,
          item.mode === "number" ? "synced" : "discovered",
          view.number,
          view.url,
        );
      }
    } catch (error) {
      if (error instanceof GitHubRateLimitError) {
        throw error;
      }
      failures.push(error);
    }
  }

  throwPullRequestPollFailures(failures);
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

interface PullRequestBatchItem {
  id: string;
  task: TaskRecord;
  targetRepoId?: string;
  worktreePath: string;
  selector: string;
  fallbackSelectors: string[];
  mode: "number" | "head";
}

interface PullRequestBatchGroup {
  worktreePath: string;
  repository: GitHubRepositoryLocator;
  items: PullRequestBatchItem[];
}

const fetchFirstFallbackPullRequestView = async (
  worktreePath: string,
  item: PullRequestBatchItem,
): Promise<Awaited<ReturnType<typeof discoverPrView>>> => {
  if (item.mode !== "head") {
    return null;
  }

  for (const selector of item.fallbackSelectors) {
    const view = await discoverPrView(selector, worktreePath);
    if (view) {
      return view;
    }
  }

  return null;
};

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

const throwPullRequestPollFailures = (failures: unknown[]): void => {
  if (failures.length === 0) return;
  if (failures.length === 1) throw failures[0];
  throw new AggregateError(failures, `${failures.length} pull request polling operations failed.`);
};
