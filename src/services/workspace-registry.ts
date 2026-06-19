import { readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";

import type {
  CommandCreateWorkspaceResult,
  CommandArchiveWorkspaceResult,
  CommandListWorkspacesResult,
  CommandRemoveWorkspaceResult,
  CommandRefreshWorkspaceResult,
  CommandRestoreWorkspaceResult,
} from "../types/command.js";
import type { CraigPaths } from "../state/craig-paths.js";
import { readCraigIndex, writeCraigIndex } from "../state/state-store.js";
import type { RepoRecord, WorkspaceRecord } from "../types/workspace.js";
import { listRepos, writeRepo } from "../state/repo-store.js";
import {
  deleteWorkspace,
  readWorkspace,
  listWorkspaceRecords,
  writeWorkspace,
} from "../state/workspace-store.js";
import { getDefaultUiState, readUiState, writeUiState } from "../state/ui-state-store.js";
import { runCommand, runCommandAllowingFailure } from "../utils/exec.js";
import { listTasks } from "./list-tasks.js";

export async function addWorkspace(paths: CraigPaths, rawPath: string): Promise<CommandCreateWorkspaceResult> {
  const rootPath = path.resolve(paths.workspaceRoot, rawPath);
  const stats = await stat(rootPath).catch(() => null);

  if (!stats?.isDirectory()) {
    throw new Error(`Workspace path does not exist: ${rootPath}`);
  }

  if (await isGitRepo(rootPath)) {
    return addRepoWorkspace(paths, rootPath);
  }

  return addProjectWorkspace(paths, rootPath);
}

export async function listWorkspaces(
  paths: CraigPaths,
  options: { archived: boolean },
): Promise<CommandListWorkspacesResult> {
  const workspaces = await listWorkspaceRecords(paths);

  return {
    kind: "listWorkspaces",
    workspaces: workspaces.filter((workspace) => workspace.status === (options.archived ? "archived" : "active")),
    archivedOnly: options.archived,
  };
}

export async function refreshWorkspace(paths: CraigPaths, workspaceId: string): Promise<CommandRefreshWorkspaceResult> {
  const workspace = await readWorkspace(paths, workspaceId);

  if (workspace.status === "archived") {
    throw new Error(`Cannot refresh archived workspace ${workspaceId}. Restore it first.`);
  }

  if (workspace.kind !== "project") {
    throw new Error(`Workspace ${workspaceId} is not a project workspace.`);
  }

  if (!workspace.rootPath) {
    throw new Error(`Workspace ${workspaceId} does not have a root path.`);
  }

  const previousRepoIds = workspace.discoveredRepoIds ?? [];
  const discovered = await discoverDirectChildRepos(paths, workspace.rootPath);
  if (discovered.length === 0) {
    throw new Error(`Workspace path does not contain direct child Git repos: ${workspace.rootPath}`);
  }

  const nextRepoIds = discovered.map((repo) => repo.id);
  const previous = new Set(previousRepoIds);
  const next = new Set(nextRepoIds);
  const addedRepoIds = nextRepoIds.filter((repoId) => !previous.has(repoId));
  const removedRepoIds = previousRepoIds.filter((repoId) => !next.has(repoId));
  const unchangedRepoIds = nextRepoIds.filter((repoId) => previous.has(repoId));
  const refreshed: WorkspaceRecord = {
    ...workspace,
    discoveredRepoIds: nextRepoIds,
    primaryRepoId: nextRepoIds[0] ?? workspace.primaryRepoId,
    linkedRepoIds: nextRepoIds,
  };

  await Promise.all(discovered.map((repo) => writeRepo(paths, repo)));
  await writeWorkspace(paths, refreshed);
  await appendIndexIds(paths, { repoIds: nextRepoIds, workspaceIds: [workspace.id] });

  return {
    kind: "refreshWorkspace",
    workspace: refreshed,
    addedRepoIds,
    removedRepoIds,
    unchangedRepoIds,
  };
}

export async function archiveWorkspace(paths: CraigPaths, workspaceId: string): Promise<CommandArchiveWorkspaceResult> {
  const workspace = await readWorkspace(paths, workspaceId);
  const archived = {
    ...workspace,
    status: "archived" as const,
    archivedAt: new Date().toISOString(),
  };

  await writeWorkspace(paths, archived);
  await clearUiSelection(paths, workspaceId);

  return {
    kind: "archiveWorkspace",
    workspaceId: archived.id,
    status: archived.status,
    branch: archived.branch,
  };
}

export async function restoreWorkspace(paths: CraigPaths, workspaceId: string): Promise<CommandRestoreWorkspaceResult> {
  const workspace = await readWorkspace(paths, workspaceId);
  const restored = {
    ...workspace,
    status: "active" as const,
    archivedAt: null,
  };

  await writeWorkspace(paths, restored);
  const ui = (await readUiState({ uiStateFile: paths.uiStateFile })) ?? null;

  await writeUiState(
    { uiStateFile: paths.uiStateFile },
    {
      ...(ui ?? getDefaultUiState()),
      selectedWorkspaceId: restored.id,
      selectedRepoId: restored.kind === "project" ? restored.discoveredRepoIds?.[0] ?? null : restored.primaryRepoId,
      selectedTaskId: null,
    },
  );

  return {
    kind: "restoreWorkspace",
    workspaceId: restored.id,
    status: restored.status,
    branch: restored.branch,
  };
}

export async function removeWorkspace(paths: CraigPaths, workspaceId: string): Promise<CommandRemoveWorkspaceResult> {
  const workspace = await readWorkspace(paths, workspaceId);
  const tasks = await listTasks(paths, { workspaceId, includeClosed: true });

  if (workspace.status === "active") {
    throw new Error(`Cannot remove workspace ${workspaceId} while it is active. Archive it first.`);
  }

  if (tasks.tasks.length > 0) {
    throw new Error(`Cannot remove workspace ${workspaceId} while task records still reference it.`);
  }

  await removeWorkspaceRecord(paths, workspaceId);
  await clearUiSelection(paths, workspaceId);

  return {
    kind: "removeWorkspace",
    workspaceId: workspace.id,
    rootPath: workspace.rootPath ?? "",
  };
}

async function addRepoWorkspace(paths: CraigPaths, rootPath: string): Promise<CommandCreateWorkspaceResult> {
  const defaultBranch = await getDefaultBranch(rootPath);
  const existingRepos = await listRepos(paths);
  const existingRepo = existingRepos.find((repo) => repo.rootPath === rootPath) ?? null;
  const repo = existingRepo ? refreshRepo(existingRepo, defaultBranch) : buildRepo(existingRepos, rootPath, defaultBranch);
  const workspaceId = `workspace_${repo.id}`;
  const workspaces = await listWorkspaceRecords(paths);
  const existingWorkspace = workspaces.find((workspace) => workspace.id === workspaceId) ?? null;
  const timestamp = new Date().toISOString();
  const workspace: WorkspaceRecord = existingWorkspace ?? {
    id: workspaceId,
    kind: "repo",
    name: repo.name,
    rootPath,
    primaryRepoId: repo.id,
    repoId: repo.id,
    discoveredRepoIds: [repo.id],
    branch: defaultBranch,
    status: "active",
    linkedRepoIds: [],
    archivedAt: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };

  await writeRepo(paths, repo);
  if (!existingWorkspace) {
    await writeWorkspace(paths, workspace);
  }
  await appendIndexIds(paths, {
    repoIds: [repo.id],
    workspaceIds: [workspace.id],
  });
  await selectWorkspace(paths, workspace, repo.id);

  return {
    kind: "createWorkspace",
    workspace,
    repos: [repo],
    created: !existingWorkspace,
  };
}

async function addProjectWorkspace(paths: CraigPaths, rootPath: string): Promise<CommandCreateWorkspaceResult> {
  const discovered = await discoverDirectChildRepos(paths, rootPath);
  if (discovered.length === 0) {
    throw new Error(`Workspace path does not contain direct child Git repos: ${rootPath}`);
  }

  const workspaces = await listWorkspaceRecords(paths);
  const workspaceId = allocateWorkspaceId(workspaces, path.basename(rootPath));
  const existing = workspaces.find((workspace) => workspace.kind === "project" && workspace.rootPath === rootPath) ?? null;
  const timestamp = new Date().toISOString();
  const repoIds = discovered.map((repo) => repo.id);
  const workspace: WorkspaceRecord = existing
    ? {
        ...existing,
        discoveredRepoIds: repoIds,
        primaryRepoId: repoIds[0] ?? existing.primaryRepoId,
        status: "active",
        archivedAt: null,
      }
    : {
        id: workspaceId,
        kind: "project",
        name: path.basename(rootPath),
        rootPath,
        primaryRepoId: repoIds[0] ?? "",
        discoveredRepoIds: repoIds,
        branch: "project",
        status: "active",
        linkedRepoIds: repoIds,
        archivedAt: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      };

  await Promise.all(discovered.map((repo) => writeRepo(paths, repo)));
  await writeWorkspace(paths, workspace);
  await appendIndexIds(paths, {
    repoIds,
    workspaceIds: [workspace.id],
  });
  await selectWorkspace(paths, workspace, repoIds[0] ?? null);

  return {
    kind: "createWorkspace",
    workspace,
    repos: discovered,
    created: !existing,
  };
}

async function discoverDirectChildRepos(paths: CraigPaths, rootPath: string): Promise<RepoRecord[]> {
  const entries = await readdir(rootPath, { withFileTypes: true });
  const existingRepos = await listRepos(paths);
  const repos: RepoRecord[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) {
      continue;
    }

    const childPath = path.join(rootPath, entry.name);
    if (!(await isGitRepo(childPath))) {
      continue;
    }

    const existing = existingRepos.find((repo) => repo.rootPath === childPath) ?? repos.find((repo) => repo.rootPath === childPath);
    const defaultBranch = await getDefaultBranch(childPath);
    repos.push(existing ? refreshRepo(existing, defaultBranch) : buildRepo([...existingRepos, ...repos], childPath, defaultBranch));
  }

  return repos.sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
}

function buildRepo(existingRepos: RepoRecord[], rootPath: string, defaultBranch: string): RepoRecord {
  const timestamp = new Date().toISOString();
  return {
    id: allocateRepoId(existingRepos, path.basename(rootPath)),
    name: path.basename(rootPath),
    rootPath,
    defaultBranch,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function refreshRepo(repo: RepoRecord, defaultBranch: string): RepoRecord {
  if (repo.defaultBranch === defaultBranch) {
    return repo;
  }

  return {
    ...repo,
    defaultBranch,
    updatedAt: new Date().toISOString(),
  };
}

function allocateRepoId(repos: RepoRecord[], name: string): string {
  const normalized = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "repo";
  let candidate = `repo_${normalized}`;
  let sequence = 2;

  while (repos.some((repo) => repo.id === candidate)) {
    candidate = `repo_${normalized}_${sequence}`;
    sequence += 1;
  }

  return candidate;
}

function allocateWorkspaceId(workspaces: WorkspaceRecord[], name: string): string {
  const normalized = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "workspace";
  let candidate = `workspace_${normalized}`;
  let sequence = 2;

  while (workspaces.some((workspace) => workspace.id === candidate)) {
    candidate = `workspace_${normalized}_${sequence}`;
    sequence += 1;
  }

  return candidate;
}

async function appendIndexIds(paths: CraigPaths, input: { repoIds: string[]; workspaceIds: string[] }): Promise<void> {
  const index = await readCraigIndex(paths);
  await writeCraigIndex(paths, {
    ...index,
    repoIds: [...new Set([...index.repoIds, ...input.repoIds])],
    workspaceIds: [...new Set([...index.workspaceIds, ...input.workspaceIds])],
  });
}

async function selectWorkspace(paths: CraigPaths, workspace: WorkspaceRecord, selectedRepoId: string | null): Promise<void> {
  await writeUiState(
    { uiStateFile: paths.uiStateFile },
    {
      ...((await readUiState({ uiStateFile: paths.uiStateFile })) ?? getDefaultUiState()),
      selectedRepoId,
      selectedWorkspaceId: workspace.id,
      selectedTaskId: null,
    },
  );
}

async function isGitRepo(rootPath: string): Promise<boolean> {
  try {
    const result = await runCommand("git", ["rev-parse", "--show-toplevel"], { cwd: rootPath });
    const gitTopLevel = result.stdout.trim();
    const [resolvedGitTop, resolvedRoot] = await Promise.all([
      realpath(gitTopLevel).catch(() => path.resolve(gitTopLevel)),
      realpath(rootPath).catch(() => path.resolve(rootPath)),
    ]);
    return resolvedGitTop === resolvedRoot;
  } catch {
    return false;
  }
}

async function getDefaultBranch(rootPath: string): Promise<string> {
  const originHead = await runCommandAllowingFailure("git", ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], {
    cwd: rootPath,
  });
  const originHeadBranch = originHead.stdout.trim().replace(/^origin\//, "");
  if (originHead.exitCode === 0 && originHeadBranch.length > 0) {
    return originHeadBranch;
  }

  for (const branchName of ["main", "master", "trunk"]) {
    const branchExists = await runCommandAllowingFailure("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branchName}`], {
      cwd: rootPath,
    });
    if (branchExists.exitCode === 0) {
      return branchName;
    }
  }

  const result = await runCommand("git", ["branch", "--show-current"], { cwd: rootPath });
  const branch = result.stdout.trim();
  return branch.length > 0 ? branch : "HEAD";
}

export async function removeWorkspaceRecord(paths: CraigPaths, workspaceId: string): Promise<void> {
  await deleteWorkspace(paths, workspaceId);
  const index = await readCraigIndex(paths);

  await writeCraigIndex(paths, {
    ...index,
    workspaceIds: index.workspaceIds.filter((id) => id !== workspaceId),
  });
}

async function clearUiSelection(paths: CraigPaths, workspaceId: string): Promise<void> {
  const ui = await readUiState({ uiStateFile: paths.uiStateFile });

  if (!ui || ui.selectedWorkspaceId !== workspaceId) {
    return;
  }

  await writeUiState(
    { uiStateFile: paths.uiStateFile },
    {
      ...ui,
      selectedWorkspaceId: null,
      selectedRepoId: null,
      selectedTaskId: null,
    },
  );
}
