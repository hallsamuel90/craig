import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { ProjectTaskRepoTarget, TaskPR, TaskPullRequest, TaskPullRequestCheck, TaskPullRequestComment, TaskPullRequestReviewDecision, TaskRecord } from "../types/task.js";
import type { CraigPaths } from "../state/craig-paths.js";
import { atomicWriteJson } from "../state/atomic-write.js";
import { readTask, writeTask } from "../state/task-store.js";
import { configService } from "../domain/config/index.js";
import { runCommand, runCommandAllowingFailure } from "../utils/exec.js";
import { resolveArtifactPath } from "./task-artifacts.js";

export interface GhPrView {
  number: number;
  url: string;
  baseRefName: string;
  headRefName: string;
  headRefOid?: string | null;
  state: string;
  isDraft?: boolean;
  mergeable: string;
  mergeStateStatus: string | null;
  title?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  mergedAt?: string | null;
  reviewDecision?: string | null;
  statusCheckRollup: unknown[];
  comments?: unknown[] | { nodes?: unknown[] | null } | null;
}

export function getTaskPrimaryPr(task: TaskRecord): TaskPR | null {
  if (task.prs.length === 0) return null;
  // Prefer the most recently added non-terminal PR for sequential workflows
  const active = [...task.prs].reverse().find(
    (pr) => pr.status !== "merged" && pr.status !== "closed",
  );
  return active ?? task.prs[task.prs.length - 1] ?? null;
}

export function isPrTerminal(pr: TaskPR): boolean {
  return pr.status === "merged" || pr.status === "closed";
}

export function upsertTaskPr(task: TaskRecord, pr: TaskPR): TaskRecord {
  const idx = task.prs.findIndex(
    (p) => p.number !== null && p.number === pr.number,
  );
  const prs = idx >= 0
    ? task.prs.map((p, i) => (i === idx ? pr : p))
    : [...task.prs, pr];
  return { ...task, prs };
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
  prNumber?: number,
): Promise<void> {
  const number = prNumber ?? getTaskPrimaryPr(task)?.number;
  if (!number) {
    throw new Error(`Task ${task.id} has no pull request to merge.`);
  }

  const flag = mergeMethod === "merge" ? "--merge" : mergeMethod === "rebase" ? "--rebase" : "--squash";

  await runCommand(
    "gh",
    ["pr", "merge", String(number), flag, "--delete-branch=false"],
    { cwd: task.worktreePath },
  );
}

export async function refreshPullRequestState(
  paths: CraigPaths,
  task: TaskRecord,
): Promise<TaskRecord> {
  const primaryPr = getTaskPrimaryPr(task);
  const selector = primaryPr?.number ? String(primaryPr.number) : task.branch;
  const result = await runCommand("gh", buildPrViewArgs(selector), {
    cwd: task.worktreePath,
  });
  const payload = JSON.parse(result.stdout) as GhPrView;
  return persistPullRequestView(paths, task, payload, primaryPr);
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
  const persistedTask = await persistPullRequestView(paths, task, payload, null);

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
  return persistPullRequestView(paths, task, view, getTaskPrimaryPr(task));
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
  const config = await configService.load(paths);
  const interval = (config.github?.watchIntervalSeconds ?? 5) * 1000;

  while (true) {
    task = await refreshPullRequestState(paths, task);
    const primaryPr = getTaskPrimaryPr(task);

    if (!primaryPr || hasReachedTerminalWatchState(primaryPr)) {
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
    prs: task.prs,
  });
}

type PrState = {
  mergeable: boolean;
  mergeStateStatus: string | null;
  reviewDecision?: TaskPullRequestReviewDecision;
  requiredChecks: TaskPullRequestCheck[];
  status: string | null;
};

export function summarizeRequiredChecks(pullRequest: { requiredChecks: TaskPullRequestCheck[] }): string {
  if (pullRequest.requiredChecks.length === 0) {
    return "no required checks";
  }

  return pullRequest.requiredChecks
    .map((check) => `${check.name}:${check.status}`)
    .join(", ");
}

export function isMergeReady(pullRequest: PrState): boolean {
  return (
    pullRequest.mergeable &&
    !isReviewBlocked(pullRequest) &&
    pullRequest.requiredChecks.length > 0 &&
    pullRequest.requiredChecks.every((check) => check.status === "success" || check.status === "skipped")
  );
}

function isReviewBlocked(pullRequest: Pick<PrState, "mergeStateStatus" | "reviewDecision">): boolean {
  return (
    pullRequest.reviewDecision === "REVIEW_REQUIRED" ||
    pullRequest.reviewDecision === "CHANGES_REQUESTED" ||
    pullRequest.mergeStateStatus === "REVIEW_REQUIRED"
  );
}

function hasFailedRequiredChecks(pullRequest: PrState): boolean {
  return pullRequest.requiredChecks.some((check) => check.status === "failed");
}

function hasReachedTerminalWatchState(pullRequest: PrState): boolean {
  return (
    isMergeReady(pullRequest) ||
    hasFailedRequiredChecks(pullRequest) ||
    pullRequest.status === "closed" ||
    pullRequest.status === "merged"
  );
}

function deriveTaskStatusFromPrs(prs: TaskPR[]): TaskRecord["status"] {
  if (prs.length === 0) return "checked";
  const primary = ([...prs].reverse().find((pr) => pr.status !== "merged" && pr.status !== "closed")
    ?? prs[prs.length - 1])!;

  if (isMergeReady(primary)) {
    return "merge_ready";
  }

  if (primary.status === "merged") {
    return "merged";
  }

  if (primary.status === "open") {
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
    "number,url,baseRefName,headRefName,headRefOid,state,isDraft,title,createdAt,updatedAt,mergedAt,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup,comments",
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
  isDraft?: boolean;
  title?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  mergedAt?: string | null;
  mergeable: string;
  mergeStateStatus: string | null;
  reviewDecision?: string | null;
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
  comments?: {
    nodes?: unknown[] | null;
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
  isDraft
  title
  createdAt
  updatedAt
  mergedAt
  mergeable
  mergeStateStatus
  reviewDecision
  statusCheckRollup {
    contexts(first: 100) {
      nodes {
        __typename
        ... on CheckRun {
          name
          status
          conclusion
          startedAt
          completedAt
        }
        ... on StatusContext {
          context
          state
          createdAt
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
                startedAt
                completedAt
              }
              ... on StatusContext {
                context
                state
                createdAt
              }
            }
          }
        }
      }
    }
  }
  comments(last: 4) {
    nodes {
      author {
        login
      }
      bodyText
      body
      createdAt
      url
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
    isDraft: pullRequest.isDraft ?? false,
    title: pullRequest.title ?? null,
    createdAt: pullRequest.createdAt ?? null,
    updatedAt: pullRequest.updatedAt ?? null,
    mergedAt: pullRequest.mergedAt ?? null,
    mergeable: pullRequest.mergeable,
    mergeStateStatus: pullRequest.mergeStateStatus,
    reviewDecision: pullRequest.reviewDecision ?? null,
    statusCheckRollup,
    comments: pullRequest.comments?.nodes ?? [],
  };
}

async function persistPullRequestView(
  paths: CraigPaths,
  task: TaskRecord,
  view: GhPrView,
  existingPr: TaskPR | null,
): Promise<TaskRecord> {
  const normalized = normalizePr(view, existingPr);
  const withPr = upsertTaskPr(task, normalized);
  const status = deriveTaskStatusFromPrs(withPr.prs);
  const withStatus = { ...withPr, status };
  await writePrStatusArtifact(paths, withStatus);
  const latest = await readTask(paths, task.id);
  const finalStatus = latest.status === "closed" ? latest.status : status;
  const persistedTask = upsertTaskPr({ ...latest, status: finalStatus }, normalized);
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

function normalizePr(view: GhPrView, existing: TaskPR | null): TaskPR {
  const isDraft = view.isDraft ?? false;
  const rawStatus = normalizePrStatus(view.state, isDraft);
  return {
    provider: "github",
    owner: existing?.owner ?? null,
    repo: existing?.repo ?? null,
    number: view.number,
    url: view.url,
    title: view.title ?? existing?.title ?? null,
    status: rawStatus,
    draft: isDraft,
    baseBranch: view.baseRefName,
    headBranch: view.headRefName,
    mergeable: view.mergeable === "MERGEABLE",
    mergeStateStatus: view.mergeStateStatus,
    reviewDecision: normalizeReviewDecision(view.reviewDecision ?? null),
    requiredChecks: normalizeRequiredChecks(view.statusCheckRollup),
    comments: normalizePullRequestComments(view.comments),
    createdAt: view.createdAt ?? existing?.createdAt ?? null,
    updatedAt: view.updatedAt ?? existing?.updatedAt ?? null,
    mergedAt: view.mergedAt ?? existing?.mergedAt ?? null,
    lastSyncedAt: new Date().toISOString(),
    lastSyncedHeadSha: view.headRefOid ?? null,
  };
}

function normalizePullRequest(view: GhPrView): TaskPullRequest {
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
    comments: normalizePullRequestComments(view.comments),
    lastSyncedAt: new Date().toISOString(),
    lastSyncedHeadSha: view.headRefOid ?? null,
  };
}

function normalizePrStatus(state: string, isDraft: boolean): TaskPR["status"] {
  if (isDraft) return "draft";
  if (state === "OPEN") return "open";
  if (state === "MERGED") return "merged";
  if (state === "CLOSED") return "closed";
  return null;
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
  const checks = entries
    .map((entry) => normalizeRequiredCheckWithSortKey(entry))
    .filter((entry): entry is NormalizedCheckWithSortKey => entry !== null);
  const byName = new Map<string, NormalizedCheckWithSortKey>();
  for (const check of checks) {
    const existing = byName.get(check.name);
    if (!existing || shouldReplaceCheck(existing, check)) {
      byName.set(check.name, check);
    }
  }
  return [...byName.values()].map((check) => ({
    name: check.name,
    status: check.status,
    conclusion: check.conclusion,
  }));
}

type NormalizedCheckWithSortKey = TaskPullRequestCheck & { sortTime: number | null };

function normalizeRequiredCheckWithSortKey(entry: unknown): NormalizedCheckWithSortKey | null {
  if (typeof entry !== "object" || entry === null) {
    return null;
  }

  const candidate = entry as {
    name?: string;
    context?: string;
    state?: string;
    status?: string;
    conclusion?: string | null;
    completedAt?: string | null;
    startedAt?: string | null;
    createdAt?: string | null;
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
    sortTime: getCheckSortTime(candidate),
  };
}

function shouldReplaceCheck(existing: NormalizedCheckWithSortKey, candidate: NormalizedCheckWithSortKey): boolean {
  if (existing.sortTime !== null || candidate.sortTime !== null) {
    return (candidate.sortTime ?? 0) >= (existing.sortTime ?? 0);
  }
  if (isCancelledCheck(existing) && !isCancelledCheck(candidate)) {
    return true;
  }
  if (!isCancelledCheck(existing) && isCancelledCheck(candidate)) {
    return false;
  }
  return checkFallbackRank(candidate.status) >= checkFallbackRank(existing.status);
}

function isCancelledCheck(check: Pick<TaskPullRequestCheck, "conclusion">): boolean {
  return check.conclusion?.toUpperCase() === "CANCELLED";
}

function checkFallbackRank(status: TaskPullRequestCheck["status"]): number {
  switch (status) {
    case "pending": return 5;
    case "failed": return 4;
    case "success": return 3;
    case "skipped": return 2;
    default: return 1;
  }
}

function getCheckSortTime(candidate: { completedAt?: string | null; startedAt?: string | null; createdAt?: string | null }): number | null {
  const isoString = candidate.completedAt ?? candidate.startedAt ?? candidate.createdAt ?? null;
  if (!isoString) return null;
  const timestamp = new Date(isoString).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

function normalizeReviewDecision(value: string | null): TaskPullRequestReviewDecision {
  if (value === "APPROVED" || value === "CHANGES_REQUESTED" || value === "REVIEW_REQUIRED") {
    return value;
  }
  return null;
}

function normalizePullRequestComments(value: GhPrView["comments"]): TaskPullRequestComment[] {
  const entries = Array.isArray(value) ? value : value?.nodes;
  if (!Array.isArray(entries)) {
    return [];
  }

  return entries
    .map(normalizePullRequestComment)
    .filter((comment): comment is TaskPullRequestComment => comment !== null)
    .slice(-4);
}

function normalizePullRequestComment(entry: unknown): TaskPullRequestComment | null {
  if (typeof entry !== "object" || entry === null) {
    return null;
  }

  const candidate = entry as {
    author?: { login?: string | null } | string | null;
    body?: string | null;
    bodyText?: string | null;
    createdAt?: string | null;
    url?: string | null;
  };
  const body = normalizeCommentBody(candidate.bodyText ?? candidate.body ?? "");
  if (!body) {
    return null;
  }

  return {
    author: typeof candidate.author === "string" ? candidate.author : candidate.author?.login ?? null,
    body,
    createdAt: candidate.createdAt ?? null,
    url: candidate.url ?? null,
  };
}

function normalizeCommentBody(value: string): string {
  return value.replace(/\s+/g, " ").trim();
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
