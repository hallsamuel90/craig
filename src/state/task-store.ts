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

  if (candidate.runnerSession !== undefined) {
    return value;
  }

  const runnerSession = buildLegacyRunnerSession(candidate);

  if (!runnerSession) {
    return value;
  }

  return {
    ...candidate,
    runnerSession,
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
    isRunnerSession(candidate.runnerSession) &&
    isPromptSource(candidate.prompt) &&
    isChecks(candidate.checks) &&
    isPullRequest(candidate.pullRequest) &&
    isArtifacts(candidate.artifacts) &&
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
    value.commands.every((entry) => typeof entry === "string")
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
    (typeof value.prDraftPath === "string" || value.prDraftPath === null) &&
    (typeof value.prStatusPath === "string" || value.prStatusPath === null)
  );
}
