import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { ProjectTaskRepoTarget, TaskPullRequest, TaskPullRequestCheck, TaskRecord } from "../types/task.js";
import type { CraigPaths } from "../state/craig-paths.js";
import { atomicWriteJson } from "../state/atomic-write.js";
import { readTask, writeTask } from "../state/task-store.js";
import { readCraigConfig } from "../state/config-store.js";
import { runCommand, runCommandAllowingFailure } from "../utils/exec.js";
import { resolveArtifactPath } from "./task-artifacts.js";

export interface GhPrView {
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

export interface GitHubRepositoryLocator {
  owner: string;
  name: string;
}

export interface GhPrBatchRequest {
  id: string;
  selector: string;
  mode: "number" | "head";
}

export interface GhPrBatchResult {
  id: string;
  found: boolean;
  view: GhPrView | null;
}

const RATE_LIMIT_RETRY_ATTEMPTS = 3;
const RATE_LIMIT_RETRY_BASE_DELAY_MS = 1_000;
const RATE_LIMIT_RETRY_MAX_DELAY_MS = 10_000;

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
): Promise<void> {
  await runCommand(
    "gh",
    [
      "pr",
      "create",
      "--base",
      "main",
      "--head",
      task.branch,
      "--title",
      task.lastCommit?.message ?? task.title,
      "--body-file",
      bodyFile,
    ],
    { cwd: task.worktreePath },
  );
}

export async function mergeGitHubPullRequest(
  task: TaskRecord,
  mergeMethod: "merge" | "rebase" | "squash",
): Promise<void> {
  const flag = mergeMethod === "merge" ? "--merge" : mergeMethod === "rebase" ? "--rebase" : "--squash";

  await runCommand(
    "gh",
    ["pr", "merge", String(task.pullRequest.number), flag, "--delete-branch=false"],
    { cwd: task.worktreePath },
  );
}

export async function refreshPullRequestState(
  paths: CraigPaths,
  task: TaskRecord,
): Promise<TaskRecord> {
  const result = await runCommand("gh", buildPrViewArgs(task.pullRequest.number ? String(task.pullRequest.number) : task.branch), {
    cwd: task.worktreePath,
  });
  const payload = JSON.parse(result.stdout) as GhPrView;
  return persistPullRequestView(paths, task, payload);
}

export async function discoverPullRequestState(
  paths: CraigPaths,
  task: TaskRecord,
): Promise<{ discovered: boolean; task: TaskRecord }> {
  const result = await runCommandAllowingFailure("gh", buildPrViewArgs(task.branch), { cwd: task.worktreePath });

  if (result.exitCode !== 0) {
    return { discovered: false, task };
  }

  const payload = JSON.parse(result.stdout) as GhPrView;
  const persistedTask = await persistPullRequestView(paths, task, payload);

  return { discovered: true, task: persistedTask };
}

export async function getGitHubRepositoryLocator(worktreePath: string): Promise<GitHubRepositoryLocator | null> {
  const result = await runCommandAllowingFailure("git", ["remote", "get-url", "origin"], { cwd: worktreePath });

  if (result.exitCode !== 0) {
    return null;
  }

  return parseGitHubRemoteUrl(result.stdout.trim());
}

export async function fetchPullRequestViewsBatch(
  worktreePath: string,
  repository: GitHubRepositoryLocator,
  requests: GhPrBatchRequest[],
): Promise<GhPrBatchResult[]> {
  if (requests.length === 0) {
    return [];
  }

  const query = buildBatchPrQuery(requests);
  const result = await runGitHubApiGraphqlWithRateLimitRetry(worktreePath, [
    "api",
    "graphql",
    "-f",
    `query=${query}`,
    "-F",
    `owner=${repository.owner}`,
    "-F",
    `name=${repository.name}`,
  ]);
  const payload = JSON.parse(result.stdout) as GhPrBatchResponse;
  const repositoryPayload = payload.data?.repository ?? {};

  return requests.map((request, index) => {
    const entry = repositoryPayload[`item${index}`];
    const view = normalizeBatchEntry(entry);
    return {
      id: request.id,
      found: view !== null,
      view,
    };
  });
}

async function runGitHubApiGraphqlWithRateLimitRetry(
  worktreePath: string,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= RATE_LIMIT_RETRY_ATTEMPTS; attempt += 1) {
    try {
      return await runCommand("gh", args, { cwd: worktreePath });
    } catch (error) {
      lastError = error;

      if (attempt === RATE_LIMIT_RETRY_ATTEMPTS || !isGitHubRateLimitError(error)) {
        throw error;
      }

      await delay(getRateLimitRetryDelayMs(attempt));
    }
  }

  throw lastError;
}

function isGitHubRateLimitError(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return (
    message.includes("rate limit") ||
    message.includes("secondary rate limit") ||
    message.includes("abuse detection") ||
    message.includes("api rate limit exceeded") ||
    message.includes("you have exceeded")
  );
}

function getRateLimitRetryDelayMs(attempt: number): number {
  const baseDelay = Number(process.env.CRAIG_GH_RATE_LIMIT_RETRY_BASE_MS) || RATE_LIMIT_RETRY_BASE_DELAY_MS;
  const exponentialDelay = Math.min(baseDelay * 2 ** attempt, RATE_LIMIT_RETRY_MAX_DELAY_MS);
  const jitter = Math.floor(Math.random() * Math.max(1, Math.floor(exponentialDelay * 0.25)));
  return exponentialDelay + jitter;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function refreshOrDiscoverTargetPullRequest(
  paths: CraigPaths,
  task: TaskRecord,
  target: ProjectTaskRepoTarget,
): Promise<"synced" | "discovered" | "not_found"> {
  const selector = target.pullRequest.number ? String(target.pullRequest.number) : target.branch;
  if (target.pullRequest.number) {
    const result = await runCommand("gh", buildPrViewArgs(selector), { cwd: target.worktreePath });
    const pullRequest = normalizePullRequest(JSON.parse(result.stdout) as GhPrView);
    target.pullRequest = pullRequest;
    await persistProjectTargetPullRequest(paths, task, target.repoId, pullRequest);
    return "synced";
  }
  const result = await runCommandAllowingFailure("gh", buildPrViewArgs(selector), { cwd: target.worktreePath });
  if (result.exitCode !== 0) {
    return "not_found";
  }
  const pullRequest = normalizePullRequest(JSON.parse(result.stdout) as GhPrView);
  target.pullRequest = pullRequest;
  await persistProjectTargetPullRequest(paths, task, target.repoId, pullRequest);
  return "discovered";
}

export async function persistTaskPullRequestView(
  paths: CraigPaths,
  task: TaskRecord,
  view: GhPrView,
): Promise<TaskRecord> {
  return persistPullRequestView(paths, task, view);
}

export async function persistTargetPullRequestView(
  paths: CraigPaths,
  task: TaskRecord,
  repoId: string,
  view: GhPrView,
): Promise<TaskRecord> {
  return persistProjectTargetPullRequest(paths, task, repoId, normalizePullRequest(view));
}

export async function waitForPullRequestState(
  paths: CraigPaths,
  task: TaskRecord,
): Promise<TaskRecord> {
  const config = await readCraigConfig(paths);
  const interval = (config.github?.watchIntervalSeconds ?? 5) * 1000;

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

function deriveTaskStatusFromPullRequest(pullRequest: TaskPullRequest): TaskRecord["status"] {
  if (isMergeReady(pullRequest)) {
    return "merge_ready";
  }

  if (pullRequest.status === "merged") {
    return "merged";
  }

  if (pullRequest.status === "open") {
    return "pr_open";
  }

  return "checked";
}

function buildPrViewArgs(selector: string): string[] {
  return [
    "pr",
    "view",
    selector,
    "--json",
    "number,url,baseRefName,headRefName,headRefOid,state,mergeable,mergeStateStatus,statusCheckRollup",
  ];
}

function parseGitHubRemoteUrl(value: string): GitHubRepositoryLocator | null {
  const normalized = value.replace(/\.git$/, "");
  const httpsMatch = normalized.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)$/);
  if (httpsMatch?.[1] && httpsMatch[2]) {
    return { owner: httpsMatch[1], name: httpsMatch[2] };
  }

  const sshMatch = normalized.match(/^git@github\.com:([^/]+)\/([^/]+)$/);
  if (sshMatch?.[1] && sshMatch[2]) {
    return { owner: sshMatch[1], name: sshMatch[2] };
  }

  const sshUrlMatch = normalized.match(/^ssh:\/\/git@github\.com\/([^/]+)\/([^/]+)$/);
  if (sshUrlMatch?.[1] && sshUrlMatch[2]) {
    return { owner: sshUrlMatch[1], name: sshUrlMatch[2] };
  }

  return null;
}

interface GhPrBatchResponse {
  data?: {
    repository?: Record<string, unknown>;
  };
}

interface GhPrBatchPullRequest {
  number: number;
  url: string;
  baseRefName: string;
  headRefName: string;
  headRefOid?: string | null;
  state: string;
  mergeable: string;
  mergeStateStatus: string | null;
  statusCheckRollup?: {
    contexts?: {
      nodes?: unknown[];
    } | null;
  } | null;
  commits?: {
    nodes?: Array<{
      commit?: {
        statusCheckRollup?: {
          contexts?: {
            nodes?: unknown[];
          } | null;
        } | null;
      } | null;
    }> | null;
  } | null;
}

function buildBatchPrQuery(requests: GhPrBatchRequest[]): string {
  const fields = requests.map((request, index) => {
    const alias = `item${index}`;
    if (request.mode === "number") {
      return `${alias}: pullRequest(number: ${Number(request.selector)}) { ...PrFields }`;
    }

    return `${alias}: pullRequests(headRefName: ${JSON.stringify(request.selector)}, states: OPEN, first: 1, orderBy: { field: UPDATED_AT, direction: DESC }) { nodes { ...PrFields } }`;
  });

  return `
query CraigPullRequestBatch($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    ${fields.join("\n    ")}
  }
}

fragment PrFields on PullRequest {
  number
  url
  baseRefName
  headRefName
  headRefOid
  state
  mergeable
  mergeStateStatus
  statusCheckRollup {
    contexts(first: 100) {
      nodes {
        __typename
        ... on CheckRun {
          name
          status
          conclusion
        }
        ... on StatusContext {
          context
          state
        }
      }
    }
  }
  commits(last: 1) {
    nodes {
      commit {
        statusCheckRollup {
          contexts(first: 100) {
            nodes {
              __typename
              ... on CheckRun {
                name
                status
                conclusion
              }
              ... on StatusContext {
                context
                state
              }
            }
          }
        }
      }
    }
  }
}
`;
}

function normalizeBatchEntry(entry: unknown): GhPrView | null {
  if (!entry || typeof entry !== "object") {
    return null;
  }

  const candidate = "nodes" in entry
    ? ((entry as { nodes?: unknown[] }).nodes?.[0] ?? null)
    : entry;

  if (!candidate || typeof candidate !== "object") {
    return null;
  }

  const pullRequest = candidate as GhPrBatchPullRequest;
  const statusCheckRollup = pullRequest.statusCheckRollup?.contexts?.nodes
    ?? pullRequest.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes
    ?? [];
  return {
    number: pullRequest.number,
    url: pullRequest.url,
    baseRefName: pullRequest.baseRefName,
    headRefName: pullRequest.headRefName,
    headRefOid: pullRequest.headRefOid ?? null,
    state: pullRequest.state,
    mergeable: pullRequest.mergeable,
    mergeStateStatus: pullRequest.mergeStateStatus,
    statusCheckRollup,
  };
}

async function persistPullRequestView(
  paths: CraigPaths,
  task: TaskRecord,
  view: GhPrView,
): Promise<TaskRecord> {
  const normalized = normalizePullRequest(view);

  task.pullRequest = normalized;
  task.status = deriveTaskStatusFromPullRequest(normalized);
  await writePrStatusArtifact(paths, task);
  const latest = await readTask(paths, task.id);
  const status = latest.status === "closed" ? latest.status : task.status;
  const persistedTask = {
    ...latest,
    pullRequest: normalized,
    status,
  };
  await writeTask(paths, persistedTask);

  return persistedTask;
}

async function persistProjectTargetPullRequest(
  paths: CraigPaths,
  task: TaskRecord,
  repoId: string,
  pullRequest: TaskPullRequest,
): Promise<TaskRecord> {
  const latest = await readTask(paths, task.id);
  const repoTargets = (latest.repoTargets ?? task.repoTargets ?? []).map((target) =>
    target.repoId === repoId ? { ...target, pullRequest } : target,
  );
  const nextTask: TaskRecord = {
    ...latest,
    repoTargets,
  };

  await writeTask(paths, nextTask);
  return nextTask;
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
