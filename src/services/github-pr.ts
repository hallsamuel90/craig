import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { TaskPullRequest, TaskPullRequestCheck, TaskRecord } from "../types/task.js";
import type { CraigPaths } from "../state/craig-paths.js";
import { atomicWriteJson } from "../state/atomic-write.js";
import { writeTask } from "../state/task-store.js";
import { readCraigConfig } from "../state/config-store.js";
import { runCommand, runCommandAllowingFailure } from "../utils/exec.js";
import { resolveArtifactPath } from "./task-artifacts.js";
import { deriveAggregateTaskStatus, getTaskWorktree, syncPrimaryReviewMirrors } from "./task-worktrees.js";

interface GhPrView {
  number: number;
  url: string;
  baseRefName: string;
  headRefName: string;
  headRefOid?: string | null;
  state: string;
  mergeable: string;
  mergeStateStatus: string | null;
  statusCheckRollup: unknown[];
}

export async function ensureGhAuthenticated(worktreePath: string): Promise<void> {
  const result = await runCommandAllowingFailure("gh", ["auth", "status"], { cwd: worktreePath });

  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || "GitHub CLI auth is required.");
  }
}

export async function ensurePrDraft(task: TaskRecord, paths: CraigPaths): Promise<string> {
  const desiredPath = resolveArtifactPath(
    paths,
    task.artifacts.prDraftPath ?? path.join(".craig", "artifacts", task.id, "pr.md"),
  );

  if (!desiredPath) {
    throw new Error(`Task ${task.id} is missing a PR draft artifact path.`);
  }

  await mkdir(path.dirname(desiredPath), { recursive: true });

  try {
    await readFile(desiredPath, "utf8");
  } catch {
    await writeFile(desiredPath, `## Summary\n\n- ${task.title}\n`, "utf8");
  }

  task.artifacts.prDraftPath = path.relative(paths.repoRoot, desiredPath);
  return desiredPath;
}

export async function createGitHubPullRequest(
  task: TaskRecord,
  bodyFile: string,
  repoId?: string,
): Promise<void> {
  const worktree = getTaskWorktree(task, repoId);
  const review = task.repoReviews[worktree.repoId] ?? task.repoReviews[task.repoId];
  await runCommand(
    "gh",
    [
      "pr",
      "create",
      "--base",
      "main",
      "--head",
      worktree.branch,
      "--title",
      review?.lastCommit?.message ?? task.title,
      "--body-file",
      bodyFile,
    ],
    { cwd: worktree.worktreePath },
  );
}

export async function mergeGitHubPullRequest(
  task: TaskRecord,
  mergeMethod: "merge" | "rebase" | "squash",
  repoId?: string,
): Promise<void> {
  const flag = mergeMethod === "merge" ? "--merge" : mergeMethod === "rebase" ? "--rebase" : "--squash";
  const worktree = getTaskWorktree(task, repoId);
  const review = task.repoReviews[worktree.repoId] ?? task.repoReviews[task.repoId];

  await runCommand(
    "gh",
    ["pr", "merge", String(review?.pullRequest.number), flag, "--delete-branch=false"],
    { cwd: worktree.worktreePath },
  );
}

export async function refreshPullRequestState(
  paths: CraigPaths,
  task: TaskRecord,
  repoId?: string,
): Promise<TaskRecord> {
  const worktree = getTaskWorktree(task, repoId);
  const review = task.repoReviews[worktree.repoId] ?? task.repoReviews[task.repoId];
  const result = await runCommand(
    "gh",
    [
      "pr",
      "view",
      review?.pullRequest.number ? String(review.pullRequest.number) : worktree.branch,
      "--json",
      "number,url,baseRefName,headRefName,headRefOid,state,mergeable,mergeStateStatus,statusCheckRollup",
    ],
    { cwd: worktree.worktreePath },
  );
  const payload = JSON.parse(result.stdout) as GhPrView;
  const normalized = normalizePullRequest(payload);

  task.repoReviews[worktree.repoId] = {
    ...(review ?? {
      repoId: worktree.repoId,
      lastCommit: null,
      status: "not_changed" as const,
      lastFailureReason: null,
      updatedAt: new Date().toISOString(),
    }),
    pullRequest: normalized,
    status: deriveReviewStatusFromPullRequest(normalized),
    lastFailureReason: null,
    updatedAt: new Date().toISOString(),
  };
  task.status = deriveAggregateTaskStatus(task);
  const mirrored = syncPrimaryReviewMirrors(task);
  await writePrStatusArtifact(paths, task);
  await writeTask(paths, mirrored);

  return mirrored;
}

export async function waitForPullRequestState(
  paths: CraigPaths,
  task: TaskRecord,
): Promise<TaskRecord> {
  const config = await readCraigConfig(paths);
  const interval = (config.github?.watchIntervalSeconds ?? 10) * 1000;

  while (true) {
    await refreshPullRequestState(paths, task);

    if (hasReachedTerminalWatchState(task.pullRequest)) {
      return task;
    }

    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}

export async function writePrStatusArtifact(paths: CraigPaths, task: TaskRecord): Promise<void> {
  const artifactPath = resolveArtifactPath(paths, task.artifacts.prStatusPath);

  if (!artifactPath) {
    return;
  }

  await mkdir(path.dirname(artifactPath), { recursive: true });
  await atomicWriteJson(artifactPath, {
    taskId: task.id,
    pullRequest: task.pullRequest,
  });
}

export function summarizeRequiredChecks(pullRequest: TaskPullRequest): string {
  if (pullRequest.requiredChecks.length === 0) {
    return "no required checks";
  }

  return pullRequest.requiredChecks
    .map((check) => `${check.name}:${check.status}`)
    .join(", ");
}

export function isMergeReady(pullRequest: TaskPullRequest): boolean {
  return (
    pullRequest.mergeable &&
    pullRequest.requiredChecks.length > 0 &&
    pullRequest.requiredChecks.every((check) => check.status === "success" || check.status === "skipped")
  );
}

function hasFailedRequiredChecks(pullRequest: TaskPullRequest): boolean {
  return pullRequest.requiredChecks.some((check) => check.status === "failed");
}

function hasReachedTerminalWatchState(pullRequest: TaskPullRequest): boolean {
  return (
    isMergeReady(pullRequest) ||
    hasFailedRequiredChecks(pullRequest) ||
    pullRequest.status === "closed" ||
    pullRequest.status === "merged"
  );
}

function deriveReviewStatusFromPullRequest(pullRequest: TaskPullRequest): TaskRecord["repoReviews"][string]["status"] {
  if (isMergeReady(pullRequest)) {
    return "merge_ready";
  }

  if (pullRequest.status === "merged") {
    return "merged";
  }

  if (pullRequest.status === "open") {
    return "pr_open";
  }

  return "committed";
}

function normalizePullRequest(view: GhPrView): TaskPullRequest {
  return {
    provider: "github",
    number: view.number,
    url: view.url,
    baseBranch: view.baseRefName,
    headBranch: view.headRefName,
    status: normalizePrState(view.state),
    mergeable: view.mergeable === "MERGEABLE",
    mergeStateStatus: view.mergeStateStatus,
    requiredChecks: normalizeRequiredChecks(view.statusCheckRollup),
    lastSyncedAt: new Date().toISOString(),
    lastSyncedHeadSha: view.headRefOid ?? null,
  };
}

function normalizePrState(state: string): TaskPullRequest["status"] {
  if (state === "OPEN") {
    return "open";
  }

  if (state === "MERGED") {
    return "merged";
  }

  if (state === "CLOSED") {
    return "closed";
  }

  return null;
}

function normalizeRequiredChecks(entries: unknown[]): TaskPullRequestCheck[] {
  return entries
    .map((entry) => normalizeRequiredCheck(entry))
    .filter((entry): entry is TaskPullRequestCheck => entry !== null);
}

function normalizeRequiredCheck(entry: unknown): TaskPullRequestCheck | null {
  if (typeof entry !== "object" || entry === null) {
    return null;
  }

  const candidate = entry as {
    name?: string;
    context?: string;
    state?: string;
    status?: string;
    conclusion?: string | null;
  };

  const name = candidate.name ?? candidate.context;
  const rawState = candidate.state ?? candidate.status ?? candidate.conclusion;

  if (!name) {
    return null;
  }

  return {
    name,
    status: normalizeCheckState(rawState ?? null, candidate.conclusion ?? null),
    conclusion: candidate.conclusion ?? null,
  };
}

function normalizeCheckState(state: string | null, conclusion: string | null): TaskPullRequestCheck["status"] {
  const normalizedState = state?.toUpperCase() ?? null;
  const normalizedConclusion = conclusion?.toUpperCase() ?? null;

  if (normalizedConclusion === "SKIPPED" || normalizedState === "SKIPPED") {
    return "skipped";
  }

  if (normalizedState === "SUCCESS" || normalizedConclusion === "SUCCESS" || normalizedConclusion === "NEUTRAL") {
    return "success";
  }

  if (
    normalizedState === "PENDING" ||
    normalizedState === "EXPECTED" ||
    normalizedState === "IN_PROGRESS" ||
    normalizedState === "QUEUED" ||
    normalizedState === "REQUESTED" ||
    normalizedState === "WAITING"
  ) {
    return "pending";
  }

  if (
    normalizedState === "FAILURE" ||
    normalizedState === "FAILED" ||
    normalizedState === "ERROR" ||
    normalizedState === "TIMED_OUT" ||
    normalizedState === "CANCELLED" ||
    normalizedState === "ACTION_REQUIRED" ||
    normalizedState === "STARTUP_FAILURE" ||
    normalizedConclusion === "FAILURE" ||
    normalizedConclusion === "FAILED" ||
    normalizedConclusion === "ERROR" ||
    normalizedConclusion === "TIMED_OUT" ||
    normalizedConclusion === "CANCELLED" ||
    normalizedConclusion === "ACTION_REQUIRED" ||
    normalizedConclusion === "STARTUP_FAILURE"
  ) {
    return "failed";
  }

  if (normalizedState === "COMPLETED" && normalizedConclusion === null) {
    return "unknown";
  }

  if (normalizedState === "COMPLETED" && normalizedConclusion !== null) {
    return normalizeCheckState(normalizedConclusion, normalizedConclusion);
  }

  if (normalizedState === null && normalizedConclusion === null) {
    return "unknown";
  }

  return "unknown";
}
