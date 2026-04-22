import { readFile } from "node:fs/promises";

import type { RunnerSession, TaskRecord } from "../types/task.js";
import type { CraigPaths } from "./craig-paths.js";
import { atomicWriteJson } from "./atomic-write.js";
import { readCraigIndex, writeCraigIndex } from "./state-store.js";

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

  const candidate = value as Partial<TaskRecord>;

  return {
    ...candidate,
    tmuxWindowTarget: typeof candidate.tmuxWindowTarget === "string" ? candidate.tmuxWindowTarget : null,
    tmuxPage: typeof candidate.tmuxPage === "number" ? candidate.tmuxPage : null,
    layoutSlot: typeof candidate.layoutSlot === "number" ? candidate.layoutSlot : null,
    runnerSession: candidate.runnerSession ?? buildLegacyRunnerSession(candidate),
    checks: normalizeLegacyChecks(candidate),
    lastCommit: candidate.lastCommit ?? null,
    pullRequest: normalizeLegacyPullRequest(candidate),
    artifacts: normalizeLegacyArtifacts(candidate),
    cleanup: normalizeLegacyCleanup(candidate),
  };
}

function buildLegacyRunnerSession(candidate: Partial<TaskRecord>): RunnerSession | null {
  if (
    typeof candidate.runner !== "string" ||
    typeof candidate.tmuxTarget !== "string" ||
    typeof candidate.title !== "string"
  ) {
    return null;
  }

  return {
    command: [candidate.runner, "agent", candidate.title],
    tmuxTarget: candidate.tmuxTarget,
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
    candidate.type === "repo" &&
    typeof candidate.status === "string" &&
    typeof candidate.runner === "string" &&
    typeof candidate.repoRoot === "string" &&
    typeof candidate.worktreePath === "string" &&
    typeof candidate.branch === "string" &&
    typeof candidate.tmuxTarget === "string" &&
    (typeof candidate.tmuxWindowTarget === "string" || candidate.tmuxWindowTarget === null) &&
    (typeof candidate.tmuxPage === "number" || candidate.tmuxPage === null) &&
    (typeof candidate.layoutSlot === "number" || candidate.layoutSlot === null) &&
    isRunnerSession(candidate.runnerSession) &&
    isPromptSource(candidate.prompt) &&
    isChecks(candidate.checks) &&
    isLastCommit(candidate.lastCommit) &&
    isPullRequest(candidate.pullRequest) &&
    isArtifacts(candidate.artifacts) &&
    isCleanup(candidate.cleanup) &&
    (candidate.lastFailureReason === undefined ||
      candidate.lastFailureReason === null ||
      typeof candidate.lastFailureReason === "string") &&
    typeof candidate.createdAt === "string" &&
    typeof candidate.updatedAt === "string"
  );
}

function isRunnerSession(value: TaskRecord["runnerSession"] | undefined): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray(value.command) &&
    value.command.every((entry) => typeof entry === "string") &&
    typeof value.tmuxTarget === "string" &&
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

function isPullRequest(value: TaskRecord["pullRequest"] | undefined): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    value.provider === "github" &&
    (typeof value.number === "number" || value.number === null) &&
    (typeof value.url === "string" || value.url === null) &&
    (typeof value.baseBranch === "string" || value.baseBranch === null) &&
    (typeof value.headBranch === "string" || value.headBranch === null) &&
    (value.status === "open" ||
      value.status === "closed" ||
      value.status === "merged" ||
      value.status === null) &&
    typeof value.mergeable === "boolean" &&
    (typeof value.mergeStateStatus === "string" || value.mergeStateStatus === null) &&
    Array.isArray(value.requiredChecks) &&
    value.requiredChecks.every(
      (check) =>
        typeof check === "object" &&
        check !== null &&
        typeof check.name === "string" &&
        (check.status === "pending" || check.status === "success" || check.status === "failed") &&
        (typeof check.conclusion === "string" || check.conclusion === null),
    ) &&
    (typeof value.lastSyncedAt === "string" || value.lastSyncedAt === null)
  );
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

function normalizeLegacyPullRequest(candidate: Partial<TaskRecord>): TaskRecord["pullRequest"] {
  const current = candidate.pullRequest;

  if (!current) {
    return {
      provider: "github",
      number: null,
      url: null,
      baseBranch: null,
      headBranch: null,
      status: null,
      mergeable: false,
      mergeStateStatus: null,
      requiredChecks: [],
      lastSyncedAt: null,
    };
  }

  return {
    ...current,
    mergeStateStatus: current.mergeStateStatus ?? null,
  };
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
