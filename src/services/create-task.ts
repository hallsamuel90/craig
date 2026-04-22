import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { CommandCreateTaskResult } from "../types/command.js";
import type { TaskRecord } from "../types/task.js";
import type { CraigPaths } from "../state/craig-paths.js";
import { appendTaskId, writeTask } from "../state/task-store.js";
import { allocateTaskId } from "./task-id.js";
import { createWorktree } from "./git-task.js";
import { createPane, enablePaneLogging } from "./tmux-session.js";
import { assertCursorAvailable, launchCursorInPane } from "./cursor-runner.js";

export async function createTask(paths: CraigPaths, title: string): Promise<CommandCreateTaskResult> {
  const trimmedTitle = title.trim();

  if (trimmedTitle.length === 0) {
    throw new Error("Task title cannot be empty.");
  }

  const taskId = await allocateTaskId(paths);
  const branch = `craig/${taskId}`;
  const worktreePath = path.join(paths.worktreesDir, taskId);
  const logPath = path.join(paths.logsDir, `${taskId}.log`);
  const prArtifactsDir = path.join(paths.artifactsDir, taskId);
  const checkSummaryPath = path.join(prArtifactsDir, "check-summary.json");
  const relativeLogPath = path.relative(paths.repoRoot, logPath);
  const task = buildDraftTask(paths, {
    taskId,
    title: trimmedTitle,
    branch,
    worktreePath,
    logPath: relativeLogPath,
    checkSummaryPath: path.relative(paths.repoRoot, checkSummaryPath),
  });

  await mkdir(prArtifactsDir, { recursive: true });
  await writeTask(paths, task);
  await appendTaskId(paths, task.id);

  try {
    await createWorktree(paths.repoRoot, branch, worktreePath);
    await writeFile(logPath, "", "utf8");

    const pane = await createPane(paths.repoRoot, worktreePath);
    task.tmuxTarget = pane.persistedTarget;
    task.runnerSession.tmuxTarget = pane.persistedTarget;

    await enablePaneLogging(pane.paneId, logPath, paths.repoRoot);
    await assertCursorAvailable(paths.repoRoot);

    const startedAt = new Date().toISOString();
    task.runnerSession.startedAt = startedAt;
    task.runnerSession.lastKnownState = "running";
    task.status = "running";
    task.lastFailureReason = null;

    await launchCursorInPane(paths.repoRoot, pane.paneId, trimmedTitle);
    await writeTask(paths, task);

    return {
      kind: "createTask",
      taskId: task.id,
      status: task.status,
      branch: task.branch,
      worktreePath: task.worktreePath,
      tmuxTarget: task.tmuxTarget,
      runner: task.runner,
    };
  } catch (error) {
    task.status = "draft";
    task.runnerSession.lastKnownState = "failed";
    task.lastFailureReason = error instanceof Error ? error.message : "Unknown Craig error";
    await writeTask(paths, task);
    throw error;
  }
}

interface DraftTaskInput {
  taskId: string;
  title: string;
  branch: string;
  worktreePath: string;
  logPath: string;
  checkSummaryPath: string;
}

function buildDraftTask(paths: CraigPaths, input: DraftTaskInput): TaskRecord {
  const timestamp = new Date().toISOString();

  return {
    id: input.taskId,
    title: input.title,
    slug: slugify(input.title),
    type: "repo",
    status: "draft",
    runner: "cursor",
    repoRoot: paths.repoRoot,
    worktreePath: input.worktreePath,
    branch: input.branch,
    tmuxTarget: "",
    runnerSession: {
      command: ["cursor", "agent", input.title],
      tmuxTarget: "",
      pid: null,
      startedAt: null,
      lastKnownState: "starting",
      exitCode: null,
      exitedAt: null,
    },
    prompt: {
      source: "inline",
      value: input.title,
    },
    checks: {
      source: {
        type: "repo_config",
        path: path.relative(paths.repoRoot, paths.configFile),
      },
      lastRunAt: null,
      status: "not_run",
      commands: [],
      results: [],
    },
    lastCommit: null,
    pullRequest: {
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
    },
    artifacts: {
      logPath: input.logPath,
      checkSummaryPath: input.checkSummaryPath,
      prDraftPath: null,
      prStatusPath: path.relative(
        paths.repoRoot,
        path.join(paths.artifactsDir, input.taskId, "pr-status.json"),
      ),
    },
    cleanup: {
      paneClosedAt: null,
      worktreeRemovedAt: null,
      preservedWorktree: false,
      warning: null,
    },
    lastFailureReason: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}
