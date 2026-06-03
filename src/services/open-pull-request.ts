import type { CommandPullRequestResult } from "../types/command.js";
import type { TaskPullRequest, TaskRecord } from "../types/task.js";
import type { CraigPaths } from "../state/craig-paths.js";
import { readTask, writeTask } from "../state/task-store.js";
import { ensureOriginRemote, isWorktreeClean, pushBranch } from "./git-task.js";
import {
  createGitHubPullRequest,
  discoverPullRequestState,
  ensureGhAuthenticated,
  ensurePrDraft,
  fetchPullRequestViewsBatch,
  getGitHubRepositoryLocator,
  type GitHubRepositoryLocator,
  isMergeReady,
  persistTargetPullRequestView,
  persistTaskPullRequestView,
  refreshOrDiscoverTargetPullRequest,
  refreshPullRequestState,
  summarizeRequiredChecks,
  waitForPullRequestState,
  writePrStatusArtifact,
} from "./github-pr.js";
import { assertTaskWorktreeExists, getTaskOrThrow } from "./task-inspection.js";

export type PullRequestSyncDisposition = "created" | "discovered" | "synced" | "not_found";

export interface PullRequestPollResult {
  taskId: string;
  synced: number;
  discovered: number;
  notFound: number;
  hadPr: boolean;
  firstDiscoveredPrNumber: number | null;
  firstDiscoveredPrUrl: string | null;
}

export async function openPullRequest(
  paths: CraigPaths,
  taskId: string,
  options: { watch: boolean },
): Promise<CommandPullRequestResult> {
  const task = await getTaskOrThrow(paths, taskId);
  await assertTaskWorktreeExists(task);
  await ensureOriginRemote(task.worktreePath);
  await ensureGhAuthenticated(task.worktreePath);

  const hadTrackedPr = Boolean(task.pullRequest.number);
  if (!hadTrackedPr) {
    const discovered = await discoverPullRequestState(paths, task);
    if (discovered.discovered) {
      if (options.watch && task.pullRequest.status !== "merged" && !isMergeReady(task.pullRequest)) {
        await waitForPullRequestState(paths, task);
      }
      return buildPullRequestResult(task, options.watch, "discovered");
    }
  }

  if (task.status !== "checked" && task.status !== "pr_open" && task.status !== "merge_ready") {
    throw new Error(`Task ${task.id} cannot open a pull request from status "${task.status}".`);
  }

  if (!task.lastCommit) {
    throw new Error(`Task ${task.id} must be committed before opening a pull request.`);
  }

  if (!(await isWorktreeClean(task.worktreePath))) {
    throw new Error(`Task ${task.id} worktree must be clean before opening a pull request.`);
  }

  const prDraftPath = await ensurePrDraft(task, paths);
  await writeTask(paths, task);

  await pushBranch(task.worktreePath, task.branch);

  if (!task.pullRequest.number) {
    await createGitHubPullRequest(task, prDraftPath);
  }

  await refreshPullRequestState(paths, task);

  if (options.watch && task.pullRequest.status !== "merged" && !isMergeReady(task.pullRequest)) {
    await waitForPullRequestState(paths, task);
  }

  await writePrStatusArtifact(paths, task);

  return buildPullRequestResult(task, options.watch, hadTrackedPr ? "synced" : "created");
}

export async function refreshTrackedPullRequest(paths: CraigPaths, taskId: string) {
  const task = await getTaskOrThrow(paths, taskId);

  if (!task.pullRequest.number) {
    return task;
  }

  await ensureGhAuthenticated(task.worktreePath);
  await refreshPullRequestState(paths, task);
  return task;
}

export async function refreshPullRequestChecks(paths: CraigPaths, taskId: string) {
  const task = await getTaskOrThrow(paths, taskId);

  if (task.type === "project" && task.repoTargets?.length) {
    await discoverOrRefreshAllProjectPullRequests(paths, taskId);
    return getTaskOrThrow(paths, taskId);
  }

  if (!task.pullRequest.number) {
    await assertTaskWorktreeExists(task);
    await ensureGhAuthenticated(task.worktreePath);
    const discovered = await discoverPullRequestState(paths, task);
    if (!discovered.discovered) {
      throw new Error(`No PR found for ${task.branch}.`);
    }
    await writePrStatusArtifact(paths, task);
    return task;
  }

  await assertTaskWorktreeExists(task);
  await ensureGhAuthenticated(task.worktreePath);
  await refreshPullRequestState(paths, task);
  await writePrStatusArtifact(paths, task);
  return task;
}

export async function discoverOrRefreshAllProjectPullRequests(
  paths: CraigPaths,
  taskId: string,
): Promise<{ synced: number; discovered: number; notFound: number }> {
  const task = await getTaskOrThrow(paths, taskId);
  const targets = (task.repoTargets ?? []).filter((t) => t.status === "ready");

  const counts = { synced: 0, discovered: 0, notFound: 0 };
  for (const target of targets) {
    await ensureGhAuthenticated(target.worktreePath);
    const disposition = target.pullRequest.number
      ? await refreshOrDiscoverTargetPullRequest(paths, task, target)
      : await refreshOrDiscoverTargetPullRequest(paths, task, target).catch(() => "not_found" as const);
    counts[disposition === "not_found" ? "notFound" : disposition]++;
  }
  const latestTask = await readTask(paths, task.id);
  if (latestTask.status !== "closed") {
    latestTask.status = deriveProjectTaskStatus(latestTask);
    latestTask.pullRequest = deriveProjectTaskPullRequest(latestTask);
    await writeTask(paths, latestTask);
  }
  return counts;
}

export async function discoverOrRefreshPullRequests(
  paths: CraigPaths,
  tasks: TaskRecord[],
): Promise<PullRequestPollResult[]> {
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

    const item: PullRequestBatchItem = {
      id: task.id,
      task,
      worktreePath: task.worktreePath,
      selector: task.pullRequest.number ? String(task.pullRequest.number) : task.branch,
      mode: task.pullRequest.number ? "number" : "head",
    };
    await enqueueBatchItem(batchGroups, item).catch(async () => {
      try {
        const { disposition, task: refreshedTask } = await discoverOrRefreshPullRequest(paths, task.id);
        recordDisposition(result, disposition, refreshedTask.pullRequest.number, refreshedTask.pullRequest.url);
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
          await persistTargetPullRequestView(paths, item.task, item.targetRepoId, batchResult.view);
        } else {
          await persistTaskPullRequestView(paths, item.task, batchResult.view);
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
    const latestTask = await readTask(paths, task.id);
    if (latestTask.status !== "closed") {
      latestTask.status = deriveProjectTaskStatus(latestTask);
      latestTask.pullRequest = deriveProjectTaskPullRequest(latestTask);
      await writeTask(paths, latestTask);
    }
  }

  return tasks.map((task) => ensurePollResult(results, task));
}

export async function discoverOrRefreshPullRequest(
  paths: CraigPaths,
  taskId: string,
): Promise<{ disposition: PullRequestSyncDisposition; task: Awaited<ReturnType<typeof getTaskOrThrow>> }> {
  const task = await getTaskOrThrow(paths, taskId);
  await assertTaskWorktreeExists(task);
  await ensureGhAuthenticated(task.worktreePath);

  if (task.pullRequest.number) {
    await refreshPullRequestState(paths, task);
    return { disposition: "synced", task };
  }

  const discovered = await discoverPullRequestState(paths, task);
  return { disposition: discovered.discovered ? "discovered" : "not_found", task };
}

function buildPullRequestResult(
  task: Awaited<ReturnType<typeof getTaskOrThrow>>,
  watch: boolean,
  disposition: Exclude<PullRequestSyncDisposition, "not_found">,
): CommandPullRequestResult {
  return {
    kind: "openPullRequest",
    taskId: task.id,
    watch,
    disposition,
    prNumber: task.pullRequest.number ?? 0,
    url: task.pullRequest.url ?? "",
    status: task.status,
    mergeable: task.pullRequest.mergeable,
    requiredChecksSummary: summarizeRequiredChecks(task.pullRequest),
  };
}

function deriveProjectTaskStatus(task: TaskRecord): TaskRecord["status"] {
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
}

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

async function enqueueBatchItem(
  groups: Map<string, PullRequestBatchGroup>,
  item: PullRequestBatchItem,
): Promise<void> {
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
}

function ensurePollResult(
  results: Map<string, PullRequestPollResult>,
  task: TaskRecord,
): PullRequestPollResult {
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
      : Boolean(task.pullRequest.number),
    firstDiscoveredPrNumber: null,
    firstDiscoveredPrUrl: null,
  };
  results.set(task.id, result);
  return result;
}

function recordDisposition(
  result: PullRequestPollResult,
  disposition: PullRequestSyncDisposition,
  prNumber: number | null,
  prUrl: string | null,
): void {
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
}

function deriveProjectTaskPullRequest(task: TaskRecord): TaskPullRequest {
  const readyTargets = (task.repoTargets ?? []).filter((target) => target.status === "ready");
  const selectedTarget = readyTargets.find((target) => target.repoId === task.selectedRepoTargetId);
  return selectedTarget?.pullRequest.number
    ? selectedTarget.pullRequest
    : readyTargets.find((target) => target.pullRequest.number)?.pullRequest ?? task.pullRequest;
}

function isProjectTargetMergeReady(pullRequest: TaskPullRequest): boolean {
  return (
    pullRequest.mergeable &&
    pullRequest.requiredChecks.length > 0 &&
    pullRequest.requiredChecks.every((check) => check.status === "success" || check.status === "skipped")
  );
}
