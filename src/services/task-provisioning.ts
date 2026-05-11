import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { CraigPaths } from "../state/craig-paths.js";
import { readRepo } from "../state/repo-store.js";
import { appendTaskId, writeTask } from "../state/task-store.js";
import type { TaskPtyTabRecord, TaskRecord, TaskWorktree } from "../types/task.js";
import { listWorkspaceRecords } from "../state/workspace-store.js";
import { createWorktree } from "./git-task.js";
import { allocateTaskIdForRepo } from "./task-id.js";
import { createRepoReview } from "./task-worktrees.js";

export interface ProvisionedTask {
  repoId: string;
  repoRoot: string;
  sessionId: string | null;
  workspaceId: string;
  task: TaskRecord;
}

export async function provisionTask(
  paths: CraigPaths,
  repoId: string,
  prompt: string,
  options: { sessionId?: string | null; linkedRepoIds?: string[] } = {},
): Promise<ProvisionedTask> {
  const repo = await readRepo(paths, repoId);
  const linkedRepoIds = [...new Set(options.linkedRepoIds ?? [])].filter((id) => id !== repo.id);
  const linkedRepos = await Promise.all(linkedRepoIds.map((id) => readRepo(paths, id)));
  const repos = [repo, ...linkedRepos];
  const workspace = await resolveWorkspaceForRepo(paths, repo.id);
  const taskId = await allocateTaskIdForRepo(paths, repo.rootPath);
  const sessionId = options.sessionId ?? null;
  const branch = `craig/${taskId}`;
  const bundlePath = path.join(paths.worktreesDir, taskId);
  const worktrees: TaskWorktree[] = repos.map((entry, index) => ({
    repoId: entry.id,
    repoRoot: entry.rootPath,
    worktreePath: repos.length === 1 ? path.join(paths.worktreesDir, entry.id, taskId) : path.join(bundlePath, entry.name),
    branch,
    role: index === 0 ? "primary" : "linked",
  }));
  const primaryWorktree = worktrees[0]!;
  const logPath = path.join(paths.logsDir, `${taskId}.log`);
  const artifactDir = path.join(paths.artifactsDir, taskId);

  await mkdir(path.dirname(primaryWorktree.worktreePath), { recursive: true });
  if (worktrees.length > 1) {
    await mkdir(bundlePath, { recursive: true });
  }
  await mkdir(artifactDir, { recursive: true });
  await writeFile(logPath, "", "utf8");

  const draftTask = buildDraftTask(paths, {
    taskId,
    repoId: repo.id,
    workspaceId: workspace.id,
    sessionId,
    repoRoot: repo.rootPath,
    prompt,
    branch,
    worktreePath: primaryWorktree.worktreePath,
    worktrees,
  });

  await writeTask(paths, draftTask);
  await appendTaskId(paths, taskId);
  const createdWorktrees: TaskWorktree[] = [];
  try {
    for (const worktree of worktrees) {
      await mkdir(path.dirname(worktree.worktreePath), { recursive: true });
      await createWorktree(worktree.repoRoot, worktree.branch, worktree.worktreePath);
      createdWorktrees.push(worktree);
    }
  } catch (error) {
    await writeTask(paths, {
      ...draftTask,
      worktrees: createdWorktrees.length > 0 ? createdWorktrees : draftTask.worktrees,
      lastFailureReason: error instanceof Error ? error.message : "Failed to create task worktrees.",
    });
    throw error;
  }

  return {
    repoId: repo.id,
    repoRoot: repo.rootPath,
    sessionId,
    workspaceId: workspace.id,
    task: draftTask,
  };
}

export function createDefaultTaskPtyTabs(taskId: string, _prompt: string, timestamp: string): TaskPtyTabRecord[] {
  return [
    {
      id: `${taskId}:agent`,
      kind: "agent",
      title: "Codex",
      command: ["codex"],
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

function buildDraftTask(paths: CraigPaths, input: DraftTaskInput): TaskRecord {
  const timestamp = new Date().toISOString();
  const ptyTabs = createDefaultTaskPtyTabs(input.taskId, input.prompt, timestamp);

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
    selectedPtyTabId: ptyTabs[0]?.id ?? null,
    linkedRepoIds: input.worktrees.filter((worktree) => worktree.role !== "primary").map((worktree) => worktree.repoId),
    worktrees: input.worktrees,
    repoRoot: input.repoRoot,
    worktreePath: input.worktreePath,
    branch: input.branch,
    ptyTabs,
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
      lastSyncedHeadSha: null,
    },
    repoReviews: Object.fromEntries(input.worktrees.map((worktree) => [worktree.repoId, createRepoReview(worktree.repoId, timestamp)])),
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

interface DraftTaskInput {
  taskId: string;
  repoId: string;
  workspaceId: string;
  sessionId: string | null;
  repoRoot: string;
  prompt: string;
  branch: string;
  worktreePath: string;
  worktrees: TaskWorktree[];
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
