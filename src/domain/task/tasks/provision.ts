import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import type { CraigPaths } from "../../../state/craig-paths.js";
import { writeTask, appendTaskId } from "../adapters/task-store.js";
import type { CraigConfig, RunnerType } from "../../config/index.js";
import { configService } from "../../config/index.js";
import type { ProjectTaskRepoTarget, TaskChecks, TaskCleanup, TaskPullRequest, TaskPtyTabRecord, TaskRecord } from "../types.js";
import type { RepoRecord } from "../../../domain/workspace/index.js";
import { readRepo, listWorkspaceRecords } from "../../../domain/workspace/index.js";
import { createWorktree } from "../adapters/git.js";
import { allocateProjectTaskId, allocateTaskIdForRepo } from "./id.js";

export interface ProvisionedTask {
  repoId: string;
  repoRoot: string;
  workspaceId: string;
  task: TaskRecord;
}

export interface ProvisionedProjectTask extends ProvisionedTask {
  bundlePath: string;
  repoTargets: ProjectTaskRepoTarget[];
}

export interface TaskLineageInput {
  parentTaskId: string | null;
  rootTaskId?: string;
  delegationDepth: number;
  delegationIdempotencyKey?: string | null;
  furyRunId?: string | null;
  furyStepId?: string | null;
}

const PROJECT_BUNDLE_GUIDE_FILENAME = ["AGENTS", "md"].join(".");

export const provisionTask = async (
  paths: CraigPaths,
  repoId: string,
  prompt: string,
  options: {
    runner?: RunnerType;
    config?: CraigConfig;
    workspaceId?: string;
    allowLinkedProjectRepo?: boolean;
    lineage?: TaskLineageInput;
  } = {},
): Promise<ProvisionedTask> => {
  const repo = await readRepo(paths, repoId);
  const [workspace, taskId] = await Promise.all([
    resolveWorkspaceForRepo(paths, repo.id, options.workspaceId, options.allowLinkedProjectRepo ?? false),
    allocateTaskIdForRepo(paths, repo.rootPath),
  ]);
  const branch = `craig/${taskId}`;
  const worktreePath = path.join(paths.worktreesDir, repo.id, taskId);
  const logPath = path.join(paths.logsDir, `${taskId}.log`);
  const artifactDir = path.join(paths.artifactsDir, taskId);

  await Promise.all([
    mkdir(path.dirname(worktreePath), { recursive: true }),
    mkdir(artifactDir, { recursive: true }),
    writeFile(logPath, "", "utf8"),
  ]);

  const draftTask = buildDraftTask(paths, {
    taskId,
    repoId: repo.id,
    workspaceId: workspace.id,
    repoRoot: repo.rootPath,
    prompt,
    runner: options.runner ?? "codex",
    config: options.config ?? {},
    branch,
    worktreePath,
    ...(options.lineage ? { lineage: options.lineage } : {}),
  });

  await writeTask(paths, draftTask);
  await appendTaskId(paths, taskId);
  await createWorktree(repo.rootPath, branch, worktreePath, repo.defaultBranch);

  return {
    repoId: repo.id,
    repoRoot: repo.rootPath,
    workspaceId: workspace.id,
    task: draftTask,
  };
};

export const provisionProjectTask = async (
  paths: CraigPaths,
  workspaceId: string,
  prompt: string,
  options: { runner?: RunnerType; config?: CraigConfig; lineage?: TaskLineageInput } = {},
): Promise<ProvisionedProjectTask> => {
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
  await writeFile(
    path.join(bundlePath, PROJECT_BUNDLE_GUIDE_FILENAME),
    buildProjectBundleAgentsMarkdown({
      taskId,
      workspaceId,
      prompt,
      repos,
      repoTargets,
      bundlePath,
    }),
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
    selectedPtyTabId: ptyTabs[0]?.id ?? null,
    linkedRepoIds: repoIds.filter((repoId) => repoId !== readyTarget.repoId),
    ...resolveLineage(taskId, options.lineage),
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
    workspaceId: workspace.id,
    task,
    bundlePath,
    repoTargets,
  };
};

export const createDefaultTaskPtyTabs = (
  taskId: string,
  _prompt: string,
  timestamp: string,
  runner: RunnerType = "codex",
  config: CraigConfig = {},
): TaskPtyTabRecord[] => {
  const profile = configService.runners.getProfile(runner);
  return [
    {
      id: `${taskId}:agent`,
      kind: "agent",
      ...(config.previews?.agentOrchestration ? { capabilityId: `capability_${randomUUID()}` } : {}),
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
};

const buildDraftTask = (paths: CraigPaths, input: DraftTaskInput): TaskRecord => {
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
    selectedPtyTabId: ptyTabs[0]?.id ?? null,
    linkedRepoIds: [],
    ...resolveLineage(input.taskId, input.lineage),
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
};

const provisionProjectRepoTarget = async (
  paths: CraigPaths,
  repo: RepoRecord,
  taskId: string,
  branch: string,
  worktreePath: string,
): Promise<ProjectTaskRepoTarget> => {
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
};

const allocateProjectRepoDirectoryNames = (repos: RepoRecord[]): Map<string, string> => {
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
};

const buildProjectBundleAgentsMarkdown = (input: {
  taskId: string;
  workspaceId: string;
  prompt: string;
  repos: RepoRecord[];
  repoTargets: ProjectTaskRepoTarget[];
  bundlePath: string;
}): string => {
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
};

const buildDefaultChecks = (configPath: string): TaskChecks => {
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
};

const buildDefaultPullRequest = (): TaskPullRequest => {
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
};

const buildDefaultCleanup = (): TaskCleanup => {
  return {
    worktreeRemovedAt: null,
    preservedWorktree: false,
    warning: null,
  };
};

interface DraftTaskInput {
  taskId: string;
  repoId: string;
  workspaceId: string;
  repoRoot: string;
  prompt: string;
  runner: RunnerType;
  config?: CraigConfig;
  branch: string;
  worktreePath: string;
  lineage?: TaskLineageInput;
}

const resolveLineage = (taskId: string, lineage?: TaskLineageInput) => ({
  parentTaskId: lineage?.parentTaskId ?? null,
  rootTaskId: lineage?.rootTaskId ?? taskId,
  delegationDepth: lineage?.delegationDepth ?? 0,
  delegationIdempotencyKey: lineage?.delegationIdempotencyKey ?? null,
  furyRunId: lineage?.furyRunId ?? null,
  furyStepId: lineage?.furyStepId ?? null,
});

const resolveWorkspaceForRepo = async (
  paths: CraigPaths,
  repoId: string,
  workspaceId?: string,
  allowLinkedProjectRepo = false,
) => {
  const workspaces = await listWorkspaceRecords(paths);
  const workspace = workspaceId
    ? workspaces.find((entry) =>
        entry.id === workspaceId && entry.status === "active" &&
        (entry.kind === "project"
          ? allowLinkedProjectRepo || entry.discoveredRepoIds?.includes(repoId)
          : entry.primaryRepoId === repoId))
    : workspaces.find((entry) => entry.kind !== "project" && entry.primaryRepoId === repoId && entry.status === "active");

  if (!workspace) {
    throw new Error(workspaceId
      ? `Repo ${repoId} is not available in active workspace ${workspaceId}.`
      : `Repo ${repoId} does not have an active workspace.`);
  }

  return workspace;
};

const slugify = (value: string): string => {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
};
