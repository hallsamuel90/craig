import { readdir, stat } from "node:fs/promises";
import path from "node:path";

import type { CraigPaths } from "../../../state/craig-paths.js";
import type { CommandCreateWorkspaceResult } from "../../../commands/types.js";
import { readCraigIndex, writeCraigIndex } from "../adapters/index-store.js";
import { listRepos, writeRepo } from "../adapters/repo-store.js";
import { listWorkspaceRecords, writeWorkspace } from "../adapters/workspace-store.js";
import { getDefaultBranch, isGitRepo } from "../adapters/git.js";
import { ensureCraigState } from "./ensure.js";
import type { RepoRecord, WorkspaceRecord } from "../types.js";

const buildRepo = (existingRepos: RepoRecord[], rootPath: string, defaultBranch: string): RepoRecord => {
  const timestamp = new Date().toISOString();
  return {
    id: allocateRepoId(existingRepos, path.basename(rootPath)),
    name: path.basename(rootPath),
    rootPath,
    defaultBranch,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
};

const refreshRepo = (repo: RepoRecord, defaultBranch: string): RepoRecord => {
  if (repo.defaultBranch === defaultBranch) return repo;
  return { ...repo, defaultBranch, updatedAt: new Date().toISOString() };
};

const allocateRepoId = (repos: RepoRecord[], name: string): string => {
  const normalized = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "repo";
  let candidate = `repo_${normalized}`;
  let sequence = 2;
  while (repos.some((repo) => repo.id === candidate)) {
    candidate = `repo_${normalized}_${sequence}`;
    sequence += 1;
  }
  return candidate;
};

const allocateWorkspaceId = (workspaces: WorkspaceRecord[], name: string): string => {
  const normalized = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "workspace";
  let candidate = `workspace_${normalized}`;
  let sequence = 2;
  while (workspaces.some((workspace) => workspace.id === candidate)) {
    candidate = `workspace_${normalized}_${sequence}`;
    sequence += 1;
  }
  return candidate;
};

const appendIndexIds = async (paths: CraigPaths, input: { repoIds: string[]; workspaceIds: string[] }): Promise<void> => {
  const index = await readCraigIndex(paths);
  await writeCraigIndex(paths, {
    ...index,
    repoIds: [...new Set([...index.repoIds, ...input.repoIds])],
    workspaceIds: [...new Set([...index.workspaceIds, ...input.workspaceIds])],
  });
};

const discoverDirectChildRepos = async (paths: CraigPaths, rootPath: string): Promise<RepoRecord[]> => {
  const entries = await readdir(rootPath, { withFileTypes: true });
  const existingRepos = await listRepos(paths);
  const repos: RepoRecord[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const childPath = path.join(rootPath, entry.name);
    if (!(await isGitRepo(childPath))) continue;
    const existing = existingRepos.find((repo) => repo.rootPath === childPath) ?? repos.find((repo) => repo.rootPath === childPath);
    const defaultBranch = await getDefaultBranch(childPath);
    repos.push(existing ? refreshRepo(existing, defaultBranch) : buildRepo([...existingRepos, ...repos], childPath, defaultBranch));
  }

  return repos.sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
};

const addRepoWorkspace = async (paths: CraigPaths, rootPath: string): Promise<CommandCreateWorkspaceResult> => {
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
  if (!existingWorkspace) await writeWorkspace(paths, workspace);
  await appendIndexIds(paths, { repoIds: [repo.id], workspaceIds: [workspace.id] });

  return { kind: "createWorkspace", workspace, repos: [repo], created: !existingWorkspace };
};

const addProjectWorkspace = async (paths: CraigPaths, rootPath: string): Promise<CommandCreateWorkspaceResult> => {
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
    ? { ...existing, discoveredRepoIds: repoIds, primaryRepoId: repoIds[0] ?? existing.primaryRepoId, status: "active", archivedAt: null }
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
  await appendIndexIds(paths, { repoIds, workspaceIds: [workspace.id] });

  return { kind: "createWorkspace", workspace, repos: discovered, created: !existing };
};

export const addWorkspace = async (paths: CraigPaths, rawPath: string): Promise<CommandCreateWorkspaceResult> => {
  await ensureCraigState(paths.workspaceRoot);
  const rootPath = path.resolve(paths.workspaceRoot, rawPath);
  const stats = await stat(rootPath).catch(() => null);

  if (!stats?.isDirectory()) {
    throw new Error(`Workspace path does not exist: ${rootPath}`);
  }

  if (await isGitRepo(rootPath)) {
    return addRepoWorkspace(paths, rootPath);
  }

  return addProjectWorkspace(paths, rootPath);
};
