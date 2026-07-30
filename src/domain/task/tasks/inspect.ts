import { access } from "node:fs/promises";
import path from "node:path";

import type { TaskInspection } from "../types.js";
import type { TaskPR, TaskRecord } from "../types.js";
import type { CraigPaths } from "../../../state/craig-paths.js";
import { CraigError } from "../../error/index.js";
import { readRawTask } from "../adapters/task-store.js";
import { validateTaskRecord } from "./validate.js";
import { getTaskPrimaryPr } from "../prs/state.js";

export const getTask = async (
  paths: CraigPaths,
  taskId: string,
  deps: { readRawTask: typeof readRawTask; validateTaskRecord: typeof validateTaskRecord } = { readRawTask, validateTaskRecord },
): Promise<TaskRecord> => {
  try {
    const raw = await deps.readRawTask(paths, taskId);
    return deps.validateTaskRecord(raw, `${paths.tasksDir}/${taskId}.json`);
  } catch (error) {
    if (isFileMissingError(error)) {
      throw new CraigError(
        "TASK_NOT_FOUND",
        `Craig task "${taskId}" was not found.`,
        { details: { taskId } },
      );
    }
    if (isInvalidTaskRecordError(error)) {
      throw new CraigError(
        "TASK_RECORD_INVALID",
        error instanceof Error ? error.message : `Craig task "${taskId}" is invalid.`,
        { details: { taskId }, cause: error },
      );
    }

    throw error;
  }
};

export const assertTaskWorktreeExists = async (task: TaskRecord): Promise<void> => {
  if (!(await pathExists(task.worktreePath))) {
    throw new Error(
      `Task ${task.id} worktree does not exist at ${task.worktreePath}. Repair or recreate the task before retrying.`,
    );
  }
};

export const resolveTaskLogPath = (paths: CraigPaths, task: TaskRecord): string | null => {
  if (!task.artifacts.logPath) {
    return null;
  }

  if (path.isAbsolute(task.artifacts.logPath)) {
    return task.artifacts.logPath;
  }

  return path.join(paths.workspaceRoot, task.artifacts.logPath);
};

export const buildTaskInspection = async (
  paths: CraigPaths,
  task: TaskRecord,
): Promise<TaskInspection> => {
  const worktreeExists = await pathExists(task.worktreePath);
  const logPath = resolveTaskLogPath(paths, task);
  const logExists = logPath ? await pathExists(logPath) : false;

  return {
    worktreeExists,
    logExists,
    recentFailureReason: task.lastFailureReason ?? null,
    runnerCommandText: task.runnerSession.command.join(" "),
    checksSummary: summarizeChecks(task),
    lastCommitSummary: summarizeLastCommit(task),
    prSummary: summarizePullRequest(task),
    cleanupSummary: summarizeCleanup(task),
  };
};

const pathExists = async (targetPath: string): Promise<boolean> => {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
};

const summarizeChecks = (task: TaskRecord): string => {
  const count = task.checks.commands.length;
  const label = count === 1 ? "command" : "commands";
  const lastRun = task.checks.lastRunAt ? ` at ${task.checks.lastRunAt}` : "";
  return `${task.checks.status} (${count} ${label})${lastRun}`;
};

const summarizeLastCommit = (task: TaskRecord): string => {
  if (!task.lastCommit) {
    return "not committed";
  }

  return `${task.lastCommit.sha.slice(0, 7)} ${task.lastCommit.message}`;
};

const summarizePullRequest = (task: TaskRecord): string => {
  if (task.type === "project" && task.repoTargets?.length) {
    const linked = task.repoTargets.filter((t) => t.pullRequest.number);
    if (linked.length === 0) return "not linked";
    const lines = linked.map((t) => `  ${t.repoId} #${t.pullRequest.number} ${t.pullRequest.status ?? "unknown"}`);
    const statusCounts = linked.reduce<Record<string, number>>((acc, t) => {
      const s = t.pullRequest.status ?? "unknown";
      acc[s] = (acc[s] ?? 0) + 1;
      return acc;
    }, {});
    const rollup = Object.entries(statusCounts).map(([s, n]) => `${n} ${s}`).join(", ");
    return `${linked.length} PR${linked.length !== 1 ? "s" : ""} (${rollup})\n${lines.join("\n")}`;
  }

  const pr: TaskPR | null = getTaskPrimaryPr(task);
  if (!pr?.number || !pr.url) {
    return "not linked";
  }

  const checks = pr.requiredChecks.length;
  const checkLabel = checks === 1 ? "check" : "checks";
  return `#${pr.number} ${pr.status ?? "unknown"} mergeable=${pr.mergeable} mergeState=${pr.mergeStateStatus ?? "unknown"} (${checks} ${checkLabel})`;
};

const summarizeCleanup = (task: TaskRecord): string => {
  if (task.status !== "merged") {
    return "not merged";
  }

  if (task.cleanup.warning) {
    return `warning: ${task.cleanup.warning}`;
  }

  if (task.cleanup.preservedWorktree) {
    return "preserved worktree";
  }

  if (task.cleanup.worktreeRemovedAt) {
    return `worktree removed at ${task.cleanup.worktreeRemovedAt}`;
  }

  return "cleanup pending";
};

const isFileMissingError = (error: unknown): error is { code: string } => {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof (error as { code?: unknown }).code === "string" &&
    (error as { code: string }).code === "ENOENT"
  );
};

const isInvalidTaskRecordError = (error: unknown): boolean =>
  error instanceof SyntaxError ||
  (error instanceof Error && error.message.startsWith("Craig task record at "));
