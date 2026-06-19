import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import type { CraigPaths } from "../state/craig-paths.js";
import { readRepo } from "../state/repo-store.js";
import { appendTaskId, readTask, writeTask } from "../state/task-store.js";
import type { CommandSyncTaskWorkspaceResult } from "../types/command.js";
import type { CraigConfig, RunnerType } from "../domain/config/index.js";
import { configService } from "../domain/config/index.js";
import type { ProjectTaskRepoTarget, TaskChecks, TaskCleanup, TaskPullRequest, TaskPtyTabRecord, TaskRecord } from "../types/task.js";
import type { RepoRecord } from "../types/workspace.js";
import { listWorkspaceRecords } from "../state/workspace-store.js";
import { createWorktree } from "./git-task.js";
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

const PROJECT_BUNDLE_GUIDE_FILENAME = ["AGENTS", "md"].join(".");

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
  await createWorktree(repo.rootPath, branch, worktreePath, repo.defaultBranch);

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
  if (!repoTargets.some((target) => target.status === "ready")) {
    await rm(bundlePath, { recursive: true, force: true });
    throw new Error(
      `No project repo targets could be provisioned for ${workspaceId}: ${repoTargets.map((target) => `${target.repoId}: ${target.failureReason ?? "unknown error"}`).join("; ")}`,
    );
  }

  await writeProjectBundleFiles({ bundlePath, taskId, workspaceId, prompt, repos, repoTargets });

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
      command: configService.runners.buildCommand(runner, prompt, options.config ?? {}),
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
    prs: [],
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

export async function syncTaskWorkspace(
  paths: CraigPaths,
  taskId: string,
): Promise<CommandSyncTaskWorkspaceResult> {
  const task = await readTask(paths, taskId);

  if (task.type !== "project") {
    throw new Error(`Task ${taskId} is not a project workspace task.`);
  }

  const workspace = (await listWorkspaceRecords(paths)).find((entry) => entry.id === task.workspaceId && entry.status === "active");
  if (!workspace) {
    throw new Error(`Workspace ${task.workspaceId} does not exist or is archived.`);
  }

  if (workspace.kind !== "project") {
    throw new Error(`Workspace ${workspace.id} is not a project workspace.`);
  }

  const bundlePath = task.bundlePath ?? task.worktreePath;
  const existingTargets = task.repoTargets ?? [];
  const existingTargetIds = existingTargets.map((target) => target.repoId);
  const existingTargetIdSet = new Set(existingTargetIds);
  const missingRepoIds = (workspace.discoveredRepoIds ?? []).filter((repoId) => !existingTargetIdSet.has(repoId));

  if (missingRepoIds.length === 0) {
    return {
      kind: "syncTaskWorkspace",
      taskId: task.id,
      workspaceId: workspace.id,
      addedTargetIds: [],
      existingTargetIds,
      skippedTargetIds: [],
    };
  }

  const missingRepos = await Promise.all(missingRepoIds.map((repoId) => readRepo(paths, repoId)));
  const repoDirectoryNames = allocateProjectRepoDirectoryNamesForMissing(existingTargets, missingRepos, bundlePath);
  const addedTargets = await Promise.all(
    missingRepos.map((repo) =>
      provisionProjectRepoTarget(paths, repo, task.id, task.branch, path.join(bundlePath, repoDirectoryNames.get(repo.id)!)),
    ),
  );
  const repoTargets = [...existingTargets, ...addedTargets];
  const allRepos = await Promise.all(repoTargets.map((target) => readRepo(paths, target.repoId)));
  const readyAddedTargets = addedTargets.filter((target) => target.status === "ready");
  const unavailableTargets = addedTargets.filter((target) => target.status === "unavailable");
  const nextTask: TaskRecord = {
    ...task,
    repoTargets,
    linkedRepoIds: repoTargets.map((target) => target.repoId).filter((repoId) => repoId !== task.repoId),
    selectedRepoTargetId: task.selectedRepoTargetId ?? readyAddedTargets[0]?.repoId ?? task.repoId,
    lastFailureReason: unavailableTargets.length > 0
      ? `Some workspace targets could not be synced: ${unavailableTargets.map((target) => `${target.repoId}: ${target.failureReason ?? "unknown error"}`).join("; ")}`
      : task.lastFailureReason ?? null,
  };

  await writeProjectBundleFiles({
    bundlePath,
    taskId: task.id,
    workspaceId: workspace.id,
    prompt: task.prompt.value,
    repos: allRepos,
    repoTargets,
  });
  await writeTask(paths, nextTask);

  return {
    kind: "syncTaskWorkspace",
    taskId: task.id,
    workspaceId: workspace.id,
    addedTargetIds: readyAddedTargets.map((target) => target.repoId),
    existingTargetIds,
    skippedTargetIds: unavailableTargets.map((target) => target.repoId),
  };
}

export function createDefaultTaskPtyTabs(
  taskId: string,
  _prompt: string,
  timestamp: string,
  runner: RunnerType = "codex",
  config: CraigConfig = {},
): TaskPtyTabRecord[] {
  const profile = configService.runners.getProfile(runner);
  return [
    {
      id: `${taskId}:agent`,
      kind: "agent",
      title: profile.defaultAgentTitle,
      command: configService.runners.buildCommand(runner, undefined, config),
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
      command: configService.runners.buildCommand(input.runner, input.prompt, input.config),
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
    prs: [],
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
    await createWorktree(repo.rootPath, branch, worktreePath, repo.defaultBranch);
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
  const usedNames = new Set(["manifest.json", PROJECT_BUNDLE_GUIDE_FILENAME]);
  const names = new Map<string, string>();

  for (const repo of repos) {
    const baseName = usedNames.has(repo.name) ? `${repo.name}-repo` : repo.name;
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

function allocateProjectRepoDirectoryNamesForMissing(
  existingTargets: ProjectTaskRepoTarget[],
  repos: RepoRecord[],
  bundlePath: string,
): Map<string, string> {
  const usedNames = new Set(["manifest.json", PROJECT_BUNDLE_GUIDE_FILENAME]);
  for (const target of existingTargets) {
    usedNames.add(path.basename(path.relative(bundlePath, target.worktreePath)));
  }

  const names = new Map<string, string>();
  for (const repo of repos) {
    const baseName = usedNames.has(repo.name) ? `${repo.name}-repo` : repo.name;
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

async function writeProjectBundleFiles(input: {
  bundlePath: string;
  taskId: string;
  workspaceId: string;
  prompt: string;
  repos: RepoRecord[];
  repoTargets: ProjectTaskRepoTarget[];
}): Promise<void> {
  await writeFile(
    path.join(input.bundlePath, "manifest.json"),
    JSON.stringify({
      taskId: input.taskId,
      workspaceId: input.workspaceId,
      prompt: input.prompt,
      repos: input.repoTargets.map((target) => ({
        repoId: target.repoId,
        repoName: input.repos.find((repo) => repo.id === target.repoId)?.name ?? target.repoId,
        path: path.relative(input.bundlePath, target.worktreePath),
        status: target.status,
        worktreePath: target.worktreePath,
        failureReason: target.failureReason,
      })),
    }, null, 2),
    "utf8",
  );
  await writeFile(
    path.join(input.bundlePath, PROJECT_BUNDLE_GUIDE_FILENAME),
    buildProjectBundleAgentsMarkdown(input),
    "utf8",
  );
}

function buildProjectBundleAgentsMarkdown(input: {
  taskId: string;
  workspaceId: string;
  prompt: string;
  repos: RepoRecord[];
  repoTargets: ProjectTaskRepoTarget[];
  bundlePath: string;
}): string {
  const repoNames = new Map(input.repos.map((repo) => [repo.id, repo.name]));
  const repoRows = input.repoTargets
    .map((target) => {
      const repoName = repoNames.get(target.repoId) ?? target.repoId;
      const relativePath = path.relative(input.bundlePath, target.worktreePath);
      const status = target.status === "ready" ? "ready" : `unavailable: ${target.failureReason ?? "unknown error"}`;
      return `- \`${relativePath}/\` - ${repoName} (${target.repoId}, ${status})`;
    })
    .join("\n");

  return [
    "# Craig Project Task Bundle",
    "",
    "This directory is a Craig project task bundle. Repo work must happen inside the child repo worktrees listed below.",
    "",
    "Run repo Git commands from a repo worktree directory, not from the bundle root. Use `manifest.json` as the machine-readable source of truth for this bundle.",
    "",
    `Task: \`${input.taskId}\``,
    `Workspace: \`${input.workspaceId}\``,
    `Prompt: ${input.prompt}`,
    "",
    "## Repo Worktrees",
    "",
    repoRows,
    "",
  ].join("\n");
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
    draft: false,
    mergeable: false,
    mergeStateStatus: null,
    reviewDecision: null,
    requiredChecks: [],
    comments: [],
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
