import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { CommandCreateTaskResult } from "../types/command.js";
import type { TaskRecord } from "../types/task.js";
import type { CraigPaths } from "../state/craig-paths.js";
import { readRepo } from "../state/repo-store.js";
import { writeSession } from "../state/session-store.js";
import { appendTaskId, writeTask } from "../state/task-store.js";
import { readUiState, writeUiState, getDefaultUiState } from "../state/ui-state-store.js";
import { listWorkspaceRecords } from "../state/workspace-store.js";
import { codexRunnerAdapter } from "./codex-runner.js";
import { createWorktree } from "./git-task.js";
import { tmuxSessionManager } from "./session-manager.js";
import { allocateTaskIdForRepo } from "./task-id.js";

export async function createTask(
  paths: CraigPaths,
  repoId: string,
  prompt: string,
): Promise<CommandCreateTaskResult> {
  const trimmedPrompt = prompt.trim();

  if (repoId.trim().length === 0) {
    throw new Error("Repo id cannot be empty.");
  }

  if (trimmedPrompt.length === 0) {
    throw new Error("Task prompt cannot be empty.");
  }

  const repo = await readRepo(paths, repoId);
  const workspace = await resolveWorkspaceForRepo(paths, repo.id);
  const taskId = await allocateTaskIdForRepo(paths, repo.rootPath);
  const sessionId = `session_${taskId}`;
  const branch = `craig/${taskId}`;
  const worktreePath = path.join(paths.worktreesDir, repo.id, taskId);
  const logPath = path.join(paths.logsDir, `${taskId}.log`);
  const artifactDir = path.join(paths.artifactsDir, taskId);

  await mkdir(path.dirname(worktreePath), { recursive: true });
  await mkdir(artifactDir, { recursive: true });
  await writeFile(logPath, "", "utf8");

  const draftTask = buildDraftTask(paths, {
    taskId,
    repoId: repo.id,
    workspaceId: workspace.id,
    sessionId,
    repoRoot: repo.rootPath,
    prompt: trimmedPrompt,
    branch,
    worktreePath,
  });

  await writeTask(paths, draftTask);
  await appendTaskId(paths, taskId);

  try {
    await createWorktree(repo.rootPath, branch, worktreePath);
    await codexRunnerAdapter.prepare(draftTask, { repoRoot: repo.rootPath });

    let session = await tmuxSessionManager.create(paths, {
      sessionId,
      taskId,
      repoId: repo.id,
      workspaceId: workspace.id,
      repoRoot: repo.rootPath,
      worktreePath,
      logPath,
      command: ["codex", trimmedPrompt],
    });
    await codexRunnerAdapter.launch(draftTask, { repoRoot: repo.rootPath, session });

    const startedAt = new Date().toISOString();
    session = {
      ...session,
      status: "running",
      startedAt,
      command: ["codex", trimmedPrompt],
    };

    const runningTask: TaskRecord = {
      ...draftTask,
      status: "running",
      runner: "codex",
      sessionId: session.id,
      runnerSession: {
        command: session.command,
        pid: null,
        startedAt,
        lastKnownState: "running",
        exitCode: null,
        exitedAt: null,
      },
    };

    await writeTask(paths, runningTask);
    await writeSession(paths, session);
    await writeUiState(
      { uiStateFile: paths.uiStateFile },
      {
        ...((await readUiState({ uiStateFile: paths.uiStateFile })) ?? getDefaultUiState()),
        selectedRepoId: runningTask.repoId,
        selectedWorkspaceId: runningTask.workspaceId,
        selectedTaskId: runningTask.id,
      },
    );

    return {
      kind: "createTask",
      taskId: runningTask.id,
      repoId: runningTask.repoId,
      sessionId: session.id,
      status: runningTask.status,
      branch: runningTask.branch,
      worktreePath: runningTask.worktreePath,
      runner: runningTask.runner,
    };
  } catch (error) {
    const failedTask: TaskRecord = {
      ...draftTask,
      status: "draft",
      runnerSession: {
        ...draftTask.runnerSession,
        lastKnownState: "failed",
      },
      lastFailureReason: error instanceof Error ? error.message : "Unknown Craig error",
    };
    await writeTask(paths, failedTask);
    throw error;
  }
}

interface DraftTaskInput {
  taskId: string;
  repoId: string;
  workspaceId: string;
  sessionId: string;
  repoRoot: string;
  prompt: string;
  branch: string;
  worktreePath: string;
}

function buildDraftTask(paths: CraigPaths, input: DraftTaskInput): TaskRecord {
  const timestamp = new Date().toISOString();

  return {
    id: input.taskId,
    title: input.prompt,
    slug: slugify(input.prompt),
    type: "repo",
    status: "draft",
    runner: "codex",
    repoId: input.repoId,
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
    linkedRepoIds: [],
    repoRoot: input.repoRoot,
    worktreePath: input.worktreePath,
    branch: input.branch,
    runnerSession: {
      command: ["codex", input.prompt],
      pid: null,
      startedAt: null,
      lastKnownState: "starting",
      exitCode: null,
      exitedAt: null,
    },
    prompt: {
      source: "inline",
      value: input.prompt,
    },
    checks: {
      source: {
        type: "repo_config",
        path: path.relative(paths.workspaceRoot, paths.configFile),
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
      logPath: path.relative(paths.workspaceRoot, path.join(paths.logsDir, `${input.taskId}.log`)),
      checkSummaryPath: path.relative(paths.workspaceRoot, path.join(paths.artifactsDir, input.taskId, "check-summary.json")),
      prDraftPath: null,
      prStatusPath: path.relative(paths.workspaceRoot, path.join(paths.artifactsDir, input.taskId, "pr-status.json")),
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

async function resolveWorkspaceForRepo(paths: CraigPaths, repoId: string) {
  const workspaces = await listWorkspaceRecords(paths);
  const workspace = workspaces.find((entry) => entry.primaryRepoId === repoId && entry.status === "active");

  if (!workspace) {
    throw new Error(`Repo ${repoId} does not have an active workspace.`);
  }

  return workspace;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}
