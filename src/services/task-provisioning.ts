import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { CraigPaths } from "../state/craig-paths.js";
import { readRepo } from "../state/repo-store.js";
import { appendTaskId, writeTask } from "../state/task-store.js";
import type { TaskPtyTabRecord, TaskRecord } from "../types/task.js";
import { listWorkspaceRecords } from "../state/workspace-store.js";
import { createWorktree } from "./git-task.js";
import { allocateTaskIdForRepo } from "./task-id.js";

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
  options: { sessionId?: string | null } = {},
): Promise<ProvisionedTask> {
  const repo = await readRepo(paths, repoId);
  const workspace = await resolveWorkspaceForRepo(paths, repo.id);
  const taskId = await allocateTaskIdForRepo(paths, repo.rootPath);
  const sessionId = options.sessionId ?? null;
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
    prompt,
    branch,
    worktreePath,
  });

  await writeTask(paths, draftTask);
  await appendTaskId(paths, taskId);
  await createWorktree(repo.rootPath, branch, worktreePath);

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
    linkedRepoIds: [],
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

interface DraftTaskInput {
  taskId: string;
  repoId: string;
  workspaceId: string;
  sessionId: string | null;
  repoRoot: string;
  prompt: string;
  branch: string;
  worktreePath: string;
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
