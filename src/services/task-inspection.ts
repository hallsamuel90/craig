import { access } from "node:fs/promises";
import path from "node:path";

import type { TaskInspection } from "../types/command.js";
import type { TaskRecord } from "../types/task.js";
import type { CraigPaths } from "../state/craig-paths.js";
import { readTask } from "../state/task-store.js";

export async function getTaskOrThrow(paths: CraigPaths, taskId: string): Promise<TaskRecord> {
  try {
    return await readTask(paths, taskId);
  } catch (error) {
    if (isFileMissingError(error)) {
      throw new Error(`Craig task "${taskId}" was not found.`);
    }

    throw error;
  }
}

export async function assertTaskWorktreeExists(task: TaskRecord): Promise<void> {
  if (!(await pathExists(task.worktreePath))) {
    throw new Error(
      `Task ${task.id} worktree does not exist at ${task.worktreePath}. Repair or recreate the task before retrying.`,
    );
  }
}

export function resolveTaskLogPath(paths: CraigPaths, task: TaskRecord): string | null {
  if (!task.artifacts.logPath) {
    return null;
  }

  if (path.isAbsolute(task.artifacts.logPath)) {
    return task.artifacts.logPath;
  }

  return path.join(paths.repoRoot, task.artifacts.logPath);
}

export async function buildTaskInspection(
  paths: CraigPaths,
  task: TaskRecord,
): Promise<TaskInspection> {
  const worktreeExists = await pathExists(task.worktreePath);
  const logPath = resolveTaskLogPath(paths, task);
  const logExists = logPath ? await pathExists(logPath) : false;

  return {
    worktreeExists,
    logExists,
    recentFailureReason: task.lastFailureReason ?? null,
    runnerCommandText: task.runnerSession.command.join(" "),
    checksSummary: summarizeChecks(task),
    prSummary: summarizePullRequest(task),
  };
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function summarizeChecks(task: TaskRecord): string {
  const count = task.checks.commands.length;
  const label = count === 1 ? "command" : "commands";
  return `${task.checks.status} (${count} ${label})`;
}

function summarizePullRequest(task: TaskRecord): string {
  if (!task.pullRequest.number || !task.pullRequest.url) {
    return "not linked";
  }

  const checks = task.pullRequest.requiredChecks.length;
  const checkLabel = checks === 1 ? "check" : "checks";
  return `#${task.pullRequest.number} ${task.pullRequest.status ?? "unknown"} mergeable=${task.pullRequest.mergeable} (${checks} ${checkLabel})`;
}

function isFileMissingError(error: unknown): error is { code: string } {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    error.code === "ENOENT"
  );
}
