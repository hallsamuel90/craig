import path from "node:path";
import { stat } from "node:fs/promises";

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
  const workspaceResult = await import("./workspace-registry.js").then(({ addWorkspace }) => addWorkspace(paths, rawPath));
  const repo = workspaceResult.repos[0];
  if (!repo || workspaceResult.workspace.kind === "project") {
    throw new Error(`Repo path is not a git repository: ${rootPath}`);
  }

  return {
    kind: "createRepo",
    repo,
    workspaceId: workspaceResult.workspace.id,
    created: workspaceResult.created,
  };
}

export async function addRepoLegacy(paths: CraigPaths, rawPath: string): Promise<CommandCreateRepoResult> {
  const rootPath = path.resolve(paths.workspaceRoot, rawPath);
  const stats = await stat(rootPath).catch(() => null);

  if (!stats?.isDirectory()) {
    throw new Error(`Repo path does not exist: ${rootPath}`);
  }

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

  await writeUiState(
    { uiStateFile: paths.uiStateFile },
    {
      ...((await readUiState({ uiStateFile: paths.uiStateFile })) ?? getDefaultUiState()),
      selectedRepoId: repo.id,
      selectedWorkspaceId: workspace.id,
      selectedTaskId: null,
    },
  );

  return {
    kind: "createRepo",
    repo,
    workspaceId: workspace.id,
    created: true,
  };
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
