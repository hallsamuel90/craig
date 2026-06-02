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
  isMergeReady,
  refreshOrDiscoverTargetPullRequest,
  refreshPullRequestState,
  summarizeRequiredChecks,
  waitForPullRequestState,
  writePrStatusArtifact,
} from "./github-pr.js";
import { assertTaskWorktreeExists, getTaskOrThrow } from "./task-inspection.js";

export type PullRequestSyncDisposition = "created" | "discovered" | "synced" | "not_found";

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
