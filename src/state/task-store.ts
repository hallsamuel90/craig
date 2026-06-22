import { readFile } from "node:fs/promises";

import type { RunnerType } from "../domain/config/index.js";
import type { ProjectTaskRepoTarget, RunnerSession, TaskPR, TaskPtyTabRecord, TaskPullRequest, TaskPullRequestComment, TaskPullRequestReviewDecision, TaskRecord } from "../types/task.js";
import type { CraigPaths } from "./craig-paths.js";
import { atomicWriteJson } from "./atomic-write.js";
import { readCraigIndex, writeCraigIndex } from "../domain/workspace/adapters/index-store.js";
import { configService } from "../domain/config/index.js";

export async function readTask(paths: CraigPaths, taskId: string): Promise<TaskRecord> {
  const raw = await readFile(getTaskFilePath(paths, taskId), "utf8");
  const parsed = JSON.parse(raw) as unknown;

  return validateTaskRecord(parsed, getTaskFilePath(paths, taskId));
}

export async function writeTask(paths: CraigPaths, task: TaskRecord): Promise<void> {
  const normalized: TaskRecord = {
    ...task,
    updatedAt: new Date().toISOString(),
  };

  await atomicWriteJson(getTaskFilePath(paths, task.id), normalized);
}

export async function appendTaskId(paths: CraigPaths, taskId: string): Promise<void> {
  const index = await readCraigIndex(paths);

  if (index.taskIds.includes(taskId)) {
    return;
  }

  await writeCraigIndex(paths, {
    ...index,
    taskIds: [...index.taskIds, taskId],
  });
}

function getTaskFilePath(paths: CraigPaths, taskId: string): string {
  return `${paths.tasksDir}/${taskId}.json`;
}

export function validateTaskRecord(value: unknown, filePath: string): TaskRecord {
  const normalized = normalizeLegacyTaskRecord(value);

  if (!isTaskRecord(normalized)) {
    throw new Error(
      `Craig task record at ${filePath} is invalid. Remove or repair the file before rerunning Craig.`,
    );
  }

  return normalized;
}

function normalizeLegacyTaskRecord(value: unknown): unknown {
  if (typeof value !== "object" || value === null) {
    return value;
  }

  const candidate = value as Partial<TaskRecord> & {
    tmuxWindowTarget?: string | null;
    tmuxPage?: number | null;
    layoutSlot?: number | null;
    tmuxTarget?: string;
  };

  return {
    ...candidate,
    runner: normalizeRunner(candidate.runner),
    repoId: typeof candidate.repoId === "string" ? candidate.repoId : "legacy_repo",
    workspaceId: typeof candidate.workspaceId === "string" ? candidate.workspaceId : "legacy_workspace",
    sessionId:
      typeof candidate.sessionId === "string" || candidate.sessionId === null ? candidate.sessionId : null,
    selectedPtyTabId:
      typeof candidate.selectedPtyTabId === "string" || candidate.selectedPtyTabId === null
        ? candidate.selectedPtyTabId
        : null,
    linkedRepoIds: Array.isArray(candidate.linkedRepoIds)
      ? candidate.linkedRepoIds.filter((entry): entry is string => typeof entry === "string")
      : [],
    ptyTabs: normalizeTaskPtyTabs(candidate),
    bundlePath: typeof candidate.bundlePath === "string" || candidate.bundlePath === null ? candidate.bundlePath : null,
    selectedRepoTargetId:
      typeof candidate.selectedRepoTargetId === "string" || candidate.selectedRepoTargetId === null
        ? candidate.selectedRepoTargetId
        : null,
    repoTargets: normalizeProjectRepoTargets(candidate.repoTargets),
    runnerSession: candidate.runnerSession ?? buildLegacyRunnerSession(candidate),
    checks: normalizeLegacyChecks(candidate),
    lastCommit: candidate.lastCommit ?? null,
    prs: normalizeLegacyPrs(candidate),
    artifacts: normalizeLegacyArtifacts(candidate),
    cleanup: normalizeLegacyCleanup(candidate),
  };
}

function buildLegacyRunnerSession(candidate: Partial<TaskRecord>): RunnerSession | null {
  if (typeof candidate.title !== "string") {
    return null;
  }
  const runner = normalizeRunner(candidate.runner);

  return {
    command: configService.runners.buildCommand(runner, candidate.title),
    pid: null,
    startedAt: null,
    lastKnownState: candidate.status === "running" ? "running" : "starting",
    exitCode: null,
    exitedAt: null,
  };
}

function isTaskRecord(value: unknown): value is TaskRecord {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Partial<TaskRecord>;

  return (
    typeof candidate.id === "string" &&
    typeof candidate.title === "string" &&
    typeof candidate.slug === "string" &&
    (candidate.type === "repo" || candidate.type === "project") &&
    typeof candidate.status === "string" &&
    configService.runners.isRunnerType(candidate.runner ?? "") &&
    typeof candidate.repoId === "string" &&
    typeof candidate.workspaceId === "string" &&
    (typeof candidate.sessionId === "string" || candidate.sessionId === null) &&
    (typeof candidate.selectedPtyTabId === "string" || candidate.selectedPtyTabId === null) &&
    Array.isArray(candidate.linkedRepoIds) &&
    candidate.linkedRepoIds.every((entry) => typeof entry === "string") &&
    typeof candidate.repoRoot === "string" &&
    typeof candidate.worktreePath === "string" &&
    typeof candidate.branch === "string" &&
    isTaskPtyTabs(candidate.ptyTabs) &&
    (candidate.bundlePath === undefined || candidate.bundlePath === null || typeof candidate.bundlePath === "string") &&
    (candidate.selectedRepoTargetId === undefined ||
      candidate.selectedRepoTargetId === null ||
      typeof candidate.selectedRepoTargetId === "string") &&
    (candidate.repoTargets === undefined || isProjectRepoTargets(candidate.repoTargets)) &&
    isRunnerSession(candidate.runnerSession) &&
    isPromptSource(candidate.prompt) &&
    isChecks(candidate.checks) &&
    isLastCommit(candidate.lastCommit) &&
    isPrs(candidate.prs) &&
    isArtifacts(candidate.artifacts) &&
    isCleanup(candidate.cleanup) &&
    (candidate.lastFailureReason === undefined ||
      candidate.lastFailureReason === null ||
      typeof candidate.lastFailureReason === "string") &&
    typeof candidate.createdAt === "string" &&
    typeof candidate.updatedAt === "string"
  );
}

function normalizeProjectRepoTargets(value: unknown): ProjectTaskRepoTarget[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  return value.filter(isProjectRepoTarget);
}

function isProjectRepoTargets(value: unknown): value is ProjectTaskRepoTarget[] {
  return Array.isArray(value) && value.every(isProjectRepoTarget);
}

function isProjectRepoTarget(value: unknown): value is ProjectTaskRepoTarget {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const target = value as Partial<ProjectTaskRepoTarget>;
  return (
    typeof target.repoId === "string" &&
    typeof target.branch === "string" &&
    typeof target.repoRoot === "string" &&
    typeof target.worktreePath === "string" &&
    (target.status === "ready" ||
      target.status === "unavailable" ||
      target.status === "merged" ||
      target.status === "closed") &&
    (typeof target.failureReason === "string" || target.failureReason === null) &&
    isChecks(target.checks) &&
    isLastCommit(target.lastCommit) &&
    isPullRequest(target.pullRequest) &&
    isCleanup(target.cleanup)
  );
}

function normalizeTaskPtyTabs(candidate: Partial<TaskRecord>): TaskPtyTabRecord[] {
  if (isTaskPtyTabs(candidate.ptyTabs)) {
    return candidate.ptyTabs;
  }

  if (typeof candidate.id !== "string" || typeof candidate.title !== "string") {
    return [];
  }

  const timestamp = typeof candidate.updatedAt === "string" ? candidate.updatedAt : new Date().toISOString();
  return buildDefaultTaskPtyTabs(candidate.id, candidate.title, timestamp, normalizeRunner(candidate.runner));
}

function buildDefaultTaskPtyTabs(taskId: string, _prompt: string, timestamp: string, runner: RunnerType): TaskPtyTabRecord[] {
  const profile = configService.runners.getProfile(runner);
  return [
    {
      id: `${taskId}:agent`,
      kind: "agent",
      title: profile.defaultAgentTitle,
      command: configService.runners.buildCommand(runner),
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    {
      id: `${taskId}:terminal`,
      kind: "terminal",
      title: "Terminal",
      command: [],
      createdAt: timestamp,
      updatedAt: timestamp,
    },
  ];
}

function normalizeRunner(value: string | null | undefined): RunnerType {
  return value && configService.runners.isRunnerType(value) ? value : "codex";
}

function isTaskPtyTabs(value: TaskRecord["ptyTabs"] | undefined): value is TaskPtyTabRecord[] {
  return (
    Array.isArray(value) &&
    value.every(
      (tab) =>
        typeof tab === "object" &&
        tab !== null &&
        typeof tab.id === "string" &&
        (tab.kind === "agent" || tab.kind === "terminal") &&
        typeof tab.title === "string" &&
        Array.isArray(tab.command) &&
        tab.command.every((entry) => typeof entry === "string") &&
        typeof tab.createdAt === "string" &&
        typeof tab.updatedAt === "string",
    )
  );
}

function isRunnerSession(value: TaskRecord["runnerSession"] | undefined): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray(value.command) &&
    value.command.every((entry) => typeof entry === "string") &&
    (typeof value.pid === "number" || value.pid === null) &&
    (typeof value.startedAt === "string" || value.startedAt === null) &&
    (value.lastKnownState === "starting" ||
      value.lastKnownState === "running" ||
      value.lastKnownState === "exited" ||
      value.lastKnownState === "failed") &&
    (typeof value.exitCode === "number" || value.exitCode === null) &&
    (typeof value.exitedAt === "string" || value.exitedAt === null)
  );
}

function isPromptSource(value: TaskRecord["prompt"] | undefined): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    (value.source === "inline" || value.source === "file") &&
    typeof value.value === "string"
  );
}

function isChecks(value: TaskRecord["checks"] | undefined): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof value.source === "object" &&
    value.source !== null &&
    value.source.type === "repo_config" &&
    typeof value.source.path === "string" &&
    (typeof value.lastRunAt === "string" || value.lastRunAt === null) &&
    (value.status === "not_run" ||
      value.status === "running" ||
      value.status === "passed" ||
      value.status === "failed") &&
    Array.isArray(value.commands) &&
    value.commands.every((entry) => typeof entry === "string") &&
    Array.isArray(value.results) &&
    value.results.every(
      (result) =>
        typeof result === "object" &&
        result !== null &&
        typeof result.command === "string" &&
        typeof result.startedAt === "string" &&
        typeof result.finishedAt === "string" &&
        typeof result.exitCode === "number",
    )
  );
}

function isLastCommit(value: TaskRecord["lastCommit"] | undefined): boolean {
  return (
    value === null ||
    (typeof value === "object" &&
      value !== null &&
      typeof value.sha === "string" &&
      typeof value.message === "string" &&
      typeof value.committedAt === "string")
  );
}

function isPullRequest(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { provider?: unknown }).provider === "github" &&
    isPullRequestChecks((value as { requiredChecks?: unknown }).requiredChecks)
  );
}

function isPullRequestChecks(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.every(
      (check) =>
        typeof check === "object" &&
        check !== null &&
        typeof check.name === "string" &&
        (check.status === "pending" ||
          check.status === "success" ||
          check.status === "failed" ||
          check.status === "skipped" ||
          check.status === "unknown") &&
        (typeof check.conclusion === "string" || check.conclusion === null),
    )
  );
}

function isPrs(value: unknown): value is TaskPR[] {
  return Array.isArray(value) && value.every(isPullRequest);
}

function isArtifacts(value: TaskRecord["artifacts"] | undefined): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    (typeof value.logPath === "string" || value.logPath === null) &&
    (typeof value.checkSummaryPath === "string" || value.checkSummaryPath === null) &&
    (typeof value.prDraftPath === "string" || value.prDraftPath === null) &&
    (typeof value.prStatusPath === "string" || value.prStatusPath === null)
  );
}

function isCleanup(value: TaskRecord["cleanup"] | undefined): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    (typeof value.paneClosedAt === "string" || value.paneClosedAt === null) &&
    (typeof value.worktreeRemovedAt === "string" || value.worktreeRemovedAt === null) &&
    typeof value.preservedWorktree === "boolean" &&
    (typeof value.warning === "string" || value.warning === null)
  );
}

function normalizeLegacyChecks(candidate: Partial<TaskRecord>): TaskRecord["checks"] {
  if (!candidate.checks) {
    return {
      source: {
        type: "repo_config",
        path: ".craig/config.json",
      },
      lastRunAt: null,
      status: "not_run",
      commands: [],
      results: [],
    };
  }

  return {
    ...candidate.checks,
    results: candidate.checks.results ?? [],
  };
}

function normalizeLegacyPrs(candidate: Partial<TaskRecord> & { pullRequest?: TaskPullRequest }): TaskPR[] {
  if (Array.isArray(candidate.prs)) {
    return candidate.prs.map(normalizeLegacyPr);
  }

  const legacy = candidate.pullRequest;
  if (!legacy || !legacy.number) {
    return [];
  }

  return [
    {
      provider: "github",
      owner: null,
      repo: null,
      number: legacy.number,
      url: legacy.url ?? null,
      title: null,
      status: normalizeLegacyPrStatus(legacy.status),
      draft: false,
      baseBranch: legacy.baseBranch ?? null,
      headBranch: legacy.headBranch ?? null,
      mergeable: legacy.mergeable ?? false,
      mergeStateStatus: legacy.mergeStateStatus ?? null,
      reviewDecision: null,
      requiredChecks: normalizeLegacyPrChecks(legacy.requiredChecks),
      comments: [],
      createdAt: null,
      updatedAt: null,
      mergedAt: null,
      lastSyncedAt: legacy.lastSyncedAt ?? null,
      lastSyncedHeadSha: legacy.lastSyncedHeadSha ?? null,
    },
  ];
}

function normalizeLegacyPr(value: unknown): TaskPR {
  const candidate = (value ?? {}) as Partial<TaskPR>;
  return {
    provider: "github",
    owner: candidate.owner ?? null,
    repo: candidate.repo ?? null,
    number: typeof candidate.number === "number" ? candidate.number : null,
    url: candidate.url ?? null,
    title: candidate.title ?? null,
    status: normalizeLegacyPrStatus(candidate.status as string | null | undefined),
    draft: candidate.draft ?? false,
    baseBranch: candidate.baseBranch ?? null,
    headBranch: candidate.headBranch ?? null,
    mergeable: candidate.mergeable ?? false,
    mergeStateStatus: candidate.mergeStateStatus ?? null,
    reviewDecision: normalizeLegacyReviewDecision(candidate.reviewDecision),
    requiredChecks: normalizeLegacyPrChecks(candidate.requiredChecks),
    comments: normalizeLegacyPrComments(candidate.comments),
    createdAt: candidate.createdAt ?? null,
    updatedAt: candidate.updatedAt ?? null,
    mergedAt: candidate.mergedAt ?? null,
    lastSyncedAt: candidate.lastSyncedAt ?? null,
    lastSyncedHeadSha: candidate.lastSyncedHeadSha ?? null,
  };
}

function normalizeLegacyPrStatus(status: string | null | undefined): TaskPR["status"] {
  if (status === "open" || status === "closed" || status === "merged" || status === "draft") {
    return status;
  }
  return null;
}

function normalizeLegacyReviewDecision(value: unknown): TaskPullRequestReviewDecision {
  if (value === "APPROVED" || value === "CHANGES_REQUESTED" || value === "REVIEW_REQUIRED") {
    return value;
  }
  return null;
}

function normalizeLegacyPrComments(value: unknown): TaskPullRequestComment[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((comment) => {
    if (typeof comment !== "object" || comment === null) {
      return [];
    }
    const candidate = comment as Partial<TaskPullRequestComment>;
    if (typeof candidate.body !== "string" || !candidate.body.trim()) {
      return [];
    }
    return [{
      author: typeof candidate.author === "string" ? candidate.author : null,
      body: candidate.body,
      createdAt: typeof candidate.createdAt === "string" ? candidate.createdAt : null,
      url: typeof candidate.url === "string" ? candidate.url : null,
    }];
  });
}

function normalizeLegacyPrChecks(
  checks: TaskPR["requiredChecks"] | undefined,
): TaskPR["requiredChecks"] {
  if (!Array.isArray(checks)) {
    return [];
  }

  return checks.map((check) => ({
    ...check,
    status:
      check.status === "pending" ||
      check.status === "success" ||
      check.status === "failed" ||
      check.status === "skipped" ||
      check.status === "unknown"
        ? check.status
        : "unknown",
    conclusion: check.conclusion ?? null,
  }));
}

function normalizeLegacyArtifacts(candidate: Partial<TaskRecord>): TaskRecord["artifacts"] {
  const current = candidate.artifacts;

  if (!current) {
    return {
      logPath: null,
      checkSummaryPath: null,
      prDraftPath: null,
      prStatusPath: null,
    };
  }

  return {
    ...current,
    checkSummaryPath: current.checkSummaryPath ?? null,
  };
}

function normalizeLegacyCleanup(candidate: Partial<TaskRecord>): TaskRecord["cleanup"] {
  return (
    candidate.cleanup ?? {
      paneClosedAt: null,
      worktreeRemovedAt: null,
      preservedWorktree: false,
      warning: null,
    }
  );
}
