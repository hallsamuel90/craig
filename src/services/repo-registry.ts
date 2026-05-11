import path from "node:path";
import { readdir, stat } from "node:fs/promises";

import type {
  CommandListReposResult,
  CommandCreateRepoResult,
  CommandRemoveRepoResult,
} from "../types/command.js";
import type { CraigPaths } from "../state/craig-paths.js";
import type { RepoRecord, WorkspaceRecord } from "../types/workspace.js";
import { readCraigIndex, writeCraigIndex } from "../state/state-store.js";
import { deleteRepo, listRepos, readRepo, writeRepo } from "../state/repo-store.js";
import { listWorkspaceRecords, writeWorkspace } from "../state/workspace-store.js";
import { getDefaultUiState, readUiState, writeUiState } from "../state/ui-state-store.js";
import { listTasks } from "./list-tasks.js";
import { removeWorkspaceRecord } from "./workspace-registry.js";
import { runCommand } from "../utils/exec.js";

export async function addRepo(paths: CraigPaths, rawPath: string): Promise<CommandCreateRepoResult> {
  const rootPath = path.resolve(paths.workspaceRoot, rawPath);
  const stats = await stat(rootPath).catch(() => null);

  if (!stats?.isDirectory()) {
    throw new Error(`Repo path does not exist: ${rootPath}`);
  }

  if (!(await isGitRepo(rootPath))) {
    const result = await addParentDirectoryRepos(paths, rootPath);
    await selectRepo(paths, result.repo.id, result.workspaceId);
    return result;
  }

  const result = await addSingleRepo(paths, rootPath);
  await selectRepo(paths, result.repo.id, result.workspaceId);
  return result;
}

async function addParentDirectoryRepos(paths: CraigPaths, rootPath: string): Promise<CommandCreateRepoResult> {
  const entries = await readdir(rootPath, { withFileTypes: true });
  const children = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(rootPath, entry.name))
    .sort((left, right) => left.localeCompare(right));
  const skipped: Array<{ path: string; reason: string }> = [];
  const registeredRepos: RepoRecord[] = [];

  for (const childPath of children) {
    if (!(await isGitRepo(childPath))) {
      skipped.push({ path: childPath, reason: "not a Git repo" });
      continue;
    }

    const result = await addSingleRepo(paths, childPath);
    registeredRepos.push(result.repo);
    if (!result.created) {
      skipped.push({ path: childPath, reason: "already registered" });
    }
  }

  if (registeredRepos.length === 0) {
    throw new Error(`No direct child Git repositories found under: ${rootPath}`);
  }

  return {
    kind: "createRepo",
    repo: registeredRepos[0]!,
    workspaceId: getWorkspaceIdForRepo(registeredRepos[0]!.id),
    created: registeredRepos.some((repo) => !skipped.some((entry) => entry.path === repo.rootPath && entry.reason === "already registered")),
    registeredRepos,
    skipped,
  };
}

async function addSingleRepo(paths: CraigPaths, rootPath: string): Promise<CommandCreateRepoResult> {
  await assertGitRepo(rootPath);
  const defaultBranch = await getCurrentBranch(rootPath);
  const existingRepos = await listRepos(paths);
  const existingByPath = existingRepos.find((repo) => repo.rootPath === rootPath);

  if (existingByPath) {
    return {
      kind: "createRepo",
      repo: existingByPath,
      workspaceId: getWorkspaceIdForRepo(existingByPath.id),
      created: false,
    };
  }

  const repoId = allocateRepoId(existingRepos, path.basename(rootPath));
  const timestamp = new Date().toISOString();
  const repo: RepoRecord = {
    id: repoId,
    name: path.basename(rootPath),
    rootPath,
    defaultBranch,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const workspace: WorkspaceRecord = {
    id: getWorkspaceIdForRepo(repoId),
    primaryRepoId: repoId,
    branch: defaultBranch,
    status: "active",
    linkedRepoIds: [],
    archivedAt: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };

  await assertBranchAvailable(paths, workspace);
  await writeRepo(paths, repo);
  await writeWorkspace(paths, workspace);

  const index = await readCraigIndex(paths);
  await writeCraigIndex(paths, {
    ...index,
    repoIds: [...index.repoIds, repo.id],
    workspaceIds: [...index.workspaceIds, workspace.id],
  });

  return {
    kind: "createRepo",
    repo,
    workspaceId: workspace.id,
    created: true,
  };
}

async function selectRepo(paths: CraigPaths, repoId: string, workspaceId: string): Promise<void> {
  await writeUiState(
    { uiStateFile: paths.uiStateFile },
    {
      ...((await readUiState({ uiStateFile: paths.uiStateFile })) ?? getDefaultUiState()),
      selectedRepoId: repoId,
      selectedWorkspaceId: workspaceId,
      selectedTaskId: null,
    },
  );
}

export async function listRegisteredRepos(paths: CraigPaths): Promise<CommandListReposResult> {
  return {
    kind: "listRepos",
    repos: await listRepos(paths),
  };
}

export async function removeRepo(paths: CraigPaths, repoId: string): Promise<CommandRemoveRepoResult> {
  const repo = await readRepo(paths, repoId);
  const workspaces = await listWorkspaceRecords(paths);
  const referencing = workspaces.filter((workspace) => workspace.primaryRepoId === repoId);
  const activeReferences = referencing.filter((workspace) => workspace.status === "active");
  const tasks = await listTasks(paths, { repoId });

  if (activeReferences.length > 0) {
    throw new Error(`Cannot remove repo ${repoId} while active workspace records still reference it.`);
  }

  if (tasks.tasks.length > 0) {
    throw new Error(`Cannot remove repo ${repoId} while task records still reference it.`);
  }

  await Promise.all(referencing.map((workspace) => removeWorkspaceRecord(paths, workspace.id)));
  await deleteRepo(paths, repoId);
  const index = await readCraigIndex(paths);

  await writeCraigIndex(paths, {
    ...index,
    repoIds: index.repoIds.filter((id) => id !== repoId),
  });

  const ui = await readUiState({ uiStateFile: paths.uiStateFile });

  if (ui?.selectedRepoId === repoId) {
    await writeUiState(
      { uiStateFile: paths.uiStateFile },
      {
        ...ui,
        selectedRepoId: null,
        selectedWorkspaceId: null,
        selectedTaskId: null,
      },
    );
  }

  return {
    kind: "removeRepo",
    repoId: repo.id,
    rootPath: repo.rootPath,
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

function getWorkspaceIdForRepo(repoId: string): string {
  return `workspace_${repoId}`;
}

async function assertGitRepo(rootPath: string): Promise<void> {
  try {
    await runCommand("git", ["rev-parse", "--show-toplevel"], { cwd: rootPath });
  } catch {
    throw new Error(`Repo path is not a git repository: ${rootPath}`);
  }
}

async function isGitRepo(rootPath: string): Promise<boolean> {
  try {
    await runCommand("git", ["rev-parse", "--show-toplevel"], { cwd: rootPath });
    return true;
  } catch {
    return false;
  }
}

async function getCurrentBranch(rootPath: string): Promise<string> {
  const result = await runCommand("git", ["branch", "--show-current"], { cwd: rootPath });
  const branch = result.stdout.trim();
  return branch.length > 0 ? branch : "HEAD";
}

async function assertBranchAvailable(paths: CraigPaths, nextWorkspace: WorkspaceRecord): Promise<void> {
  const workspaces = await listWorkspaceRecords(paths);
  const conflict = workspaces.find(
    (workspace) =>
      workspace.status === "active" &&
      workspace.primaryRepoId === nextWorkspace.primaryRepoId &&
      workspace.branch === nextWorkspace.branch,
  );

  if (conflict) {
    throw new Error(
      `Workspace branch already in use for repo ${nextWorkspace.primaryRepoId}: ${nextWorkspace.branch}`,
    );
  }
}
