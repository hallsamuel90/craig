import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { CraigPaths } from "../state/craig-paths.js";
import { readRepo } from "../state/repo-store.js";
import { appendTaskId, writeTask } from "../state/task-store.js";
import type { CraigConfig } from "../types/config.js";
import type { ProjectTaskRepoTarget, RunnerType, TaskChecks, TaskCleanup, TaskPullRequest, TaskPtyTabRecord, TaskRecord } from "../types/task.js";
import type { RepoRecord } from "../types/workspace.js";
import { listWorkspaceRecords } from "../state/workspace-store.js";
import { createWorktree } from "./git-task.js";
import { buildRunnerCommand, getRunnerProfile } from "./runner-profiles.js";
import { allocateProjectTaskId, allocateTaskIdForRepo } from "./task-id.js";

export interface ProvisionedTask {
  repoId: string;
  repoRoot: string;
  sessionId: string | null;
  workspaceId: string;
  task: TaskRecord;
}

export interface ProvisionedProjectTask extends ProvisionedTask {
  bundlePath: string;
  repoTargets: ProjectTaskRepoTarget[];
}

export async function provisionTask(
  paths: CraigPaths,
  repoId: string,
  prompt: string,
  options: { sessionId?: string | null; runner?: RunnerType; config?: CraigConfig } = {},
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
    runner: options.runner ?? "codex",
    config: options.config ?? {},
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

export async function provisionProjectTask(
  paths: CraigPaths,
  workspaceId: string,
  prompt: string,
  options: { sessionId?: string | null; runner?: RunnerType; config?: CraigConfig } = {},
): Promise<ProvisionedProjectTask> {
  const workspace = (await listWorkspaceRecords(paths)).find((entry) => entry.id === workspaceId && entry.status === "active");
  if (!workspace) {
    throw new Error(`Workspace ${workspaceId} does not exist or is archived.`);
  }
  if (workspace.kind !== "project") {
    if (!workspace.primaryRepoId) {
      throw new Error(`Workspace ${workspaceId} is not task-capable.`);
    }
    const repoTask = await provisionTask(paths, workspace.primaryRepoId, prompt, options);
    return {
      ...repoTask,
      bundlePath: repoTask.task.worktreePath,
      repoTargets: [],
    };
  }

  const repoIds = workspace.discoveredRepoIds ?? [];
  if (repoIds.length === 0) {
    throw new Error(`Project workspace ${workspaceId} has no discovered repos.`);
  }

  const taskId = await allocateProjectTaskId(paths);
  const timestamp = new Date().toISOString();
  const runner = options.runner ?? "codex";
  const sessionId = options.sessionId ?? null;
  const branch = `craig/${taskId}`;
  const bundlePath = path.join(paths.craigDir, "task-bundles", taskId);
  const logPath = path.join(paths.logsDir, `${taskId}.log`);
  const artifactDir = path.join(paths.artifactsDir, taskId);

  await mkdir(bundlePath, { recursive: true });
  await mkdir(artifactDir, { recursive: true });
  await writeFile(logPath, "", "utf8");

  const repos = await Promise.all(repoIds.map((repoId) => readRepo(paths, repoId)));
  const repoDirectoryNames = allocateProjectRepoDirectoryNames(repos);
  const repoTargets = await Promise.all(
    repos.map((repo) => provisionProjectRepoTarget(paths, repo, taskId, branch, path.join(bundlePath, repoDirectoryNames.get(repo.id)!))),
  );
  const readyTarget = repoTargets.find((target) => target.status === "ready") ?? repoTargets[0]!;

  await writeFile(
    path.join(bundlePath, "manifest.json"),
    JSON.stringify({
      taskId,
      workspaceId,
      prompt,
      repos: repoTargets.map((target) => ({
        repoId: target.repoId,
        repoName: repos.find((repo) => repo.id === target.repoId)?.name ?? target.repoId,
        path: path.relative(bundlePath, target.worktreePath),
        status: target.status,
        worktreePath: target.worktreePath,
        failureReason: target.failureReason,
      })),
    }, null, 2),
    "utf8",
  );

  const ptyTabs = createDefaultTaskPtyTabs(taskId, prompt, timestamp, runner, options.config ?? {});
  const task: TaskRecord = {
    id: taskId,
    title: prompt,
    slug: slugify(prompt),
    type: "project",
    status: "draft",
    runner,
    repoId: readyTarget.repoId,
    workspaceId: workspace.id,
    sessionId,
    selectedPtyTabId: ptyTabs[0]?.id ?? null,
    linkedRepoIds: repoIds.filter((repoId) => repoId !== readyTarget.repoId),
    repoRoot: bundlePath,
    worktreePath: bundlePath,
    branch,
    bundlePath,
    selectedRepoTargetId: readyTarget.repoId,
    repoTargets,
    ptyTabs,
    runnerSession: {
      command: buildRunnerCommand(runner, prompt, options.config ?? {}),
      pid: null,
      startedAt: null,
      lastKnownState: "starting",
      exitCode: null,
      exitedAt: null,
    },
    prompt: {
      source: "inline",
      value: prompt,
    },
    checks: readyTarget.checks,
    lastCommit: null,
    pullRequest: readyTarget.pullRequest,
    artifacts: {
      logPath: path.relative(paths.workspaceRoot, logPath),
      checkSummaryPath: path.relative(paths.workspaceRoot, path.join(artifactDir, "check-summary.json")),
      prDraftPath: null,
      prStatusPath: path.relative(paths.workspaceRoot, path.join(artifactDir, "pr-status.json")),
    },
    cleanup: buildDefaultCleanup(),
    lastFailureReason: repoTargets.every((target) => target.status === "unavailable")
      ? "No project repo targets could be provisioned."
      : null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };

  await writeTask(paths, task);
  await appendTaskId(paths, taskId);

  return {
    repoId: readyTarget.repoId,
    repoRoot: bundlePath,
    sessionId,
    workspaceId: workspace.id,
    task,
    bundlePath,
    repoTargets,
  };
}

export function createDefaultTaskPtyTabs(
  taskId: string,
  _prompt: string,
  timestamp: string,
  runner: RunnerType = "codex",
  config: CraigConfig = {},
): TaskPtyTabRecord[] {
  const profile = getRunnerProfile(runner);
  return [
    {
      id: `${taskId}:agent`,
      kind: "agent",
      title: profile.defaultAgentTitle,
      command: buildRunnerCommand(runner, undefined, config),
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
  const ptyTabs = createDefaultTaskPtyTabs(input.taskId, input.prompt, timestamp, input.runner, input.config);

  return {
    id: input.taskId,
    title: input.prompt,
    slug: slugify(input.prompt),
    type: "repo",
    status: "draft",
    runner: input.runner,
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
      command: buildRunnerCommand(input.runner, input.prompt, input.config),
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
      ...buildDefaultChecks(path.relative(paths.workspaceRoot, paths.configFile)),
    },
    lastCommit: null,
    pullRequest: buildDefaultPullRequest(),
    artifacts: {
      logPath: path.relative(paths.workspaceRoot, path.join(paths.logsDir, `${input.taskId}.log`)),
      checkSummaryPath: path.relative(paths.workspaceRoot, path.join(paths.artifactsDir, input.taskId, "check-summary.json")),
      prDraftPath: null,
      prStatusPath: path.relative(paths.workspaceRoot, path.join(paths.artifactsDir, input.taskId, "pr-status.json")),
    },
    cleanup: buildDefaultCleanup(),
    lastFailureReason: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

async function provisionProjectRepoTarget(
  paths: CraigPaths,
  repo: RepoRecord,
  taskId: string,
  branch: string,
  worktreePath: string,
): Promise<ProjectTaskRepoTarget> {
  await mkdir(path.dirname(worktreePath), { recursive: true });

  try {
    await createWorktree(repo.rootPath, branch, worktreePath);
    return {
      repoId: repo.id,
      branch,
      repoRoot: repo.rootPath,
      worktreePath,
      status: "ready",
      failureReason: null,
      checks: buildDefaultChecks(path.relative(paths.workspaceRoot, paths.configFile)),
      lastCommit: null,
      pullRequest: buildDefaultPullRequest(),
      cleanup: buildDefaultCleanup(),
    };
  } catch (error) {
    return {
      repoId: repo.id,
      branch,
      repoRoot: repo.rootPath,
      worktreePath,
      status: "unavailable",
      failureReason: error instanceof Error ? error.message : "Failed to create worktree.",
      checks: buildDefaultChecks(path.relative(paths.workspaceRoot, paths.configFile)),
      lastCommit: null,
      pullRequest: buildDefaultPullRequest(),
      cleanup: buildDefaultCleanup(),
    };
  }
}

function allocateProjectRepoDirectoryNames(repos: RepoRecord[]): Map<string, string> {
  const usedNames = new Set(["manifest.json"]);
  const names = new Map<string, string>();

  for (const repo of repos) {
    const baseName = repo.name === "manifest.json" ? `${repo.name}-repo` : repo.name;
    let candidate = baseName;
    let suffix = 2;

    while (usedNames.has(candidate)) {
      candidate = `${baseName}-${suffix}`;
      suffix += 1;
    }

    usedNames.add(candidate);
    names.set(repo.id, candidate);
  }

  return names;
}

function buildDefaultChecks(configPath: string): TaskChecks {
  return {
    source: {
      type: "repo_config",
      path: configPath,
    },
    lastRunAt: null,
    status: "not_run",
    commands: [],
    results: [],
  };
}

function buildDefaultPullRequest(): TaskPullRequest {
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
    lastSyncedHeadSha: null,
  };
}

function buildDefaultCleanup(): TaskCleanup {
  return {
    paneClosedAt: null,
    worktreeRemovedAt: null,
    preservedWorktree: false,
    warning: null,
  };
}

interface DraftTaskInput {
  taskId: string;
  repoId: string;
  workspaceId: string;
  sessionId: string | null;
  repoRoot: string;
  prompt: string;
  runner: RunnerType;
  config?: CraigConfig;
  branch: string;
  worktreePath: string;
}

async function resolveWorkspaceForRepo(paths: CraigPaths, repoId: string) {
  const workspaces = await listWorkspaceRecords(paths);
  const workspace = workspaces.find((entry) => entry.kind !== "project" && entry.primaryRepoId === repoId && entry.status === "active");

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
