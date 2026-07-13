export interface RepoRecord {
  id: string;
  name: string;
  rootPath: string;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
}

export type WorkspaceStatus = "active" | "archived";

export interface WorkspaceRecord {
  id: string;
  kind?: "repo" | "project";
  name?: string;
  rootPath?: string;
  primaryRepoId: string;
  repoId?: string;
  discoveredRepoIds?: string[];
  branch: string;
  status: WorkspaceStatus;
  linkedRepoIds: string[];
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CommandCreateWorkspaceResult {
  kind: "createWorkspace";
  workspace: WorkspaceRecord;
  repos: RepoRecord[];
  created: boolean;
}

export interface CommandCreateRepoResult {
  kind: "createRepo";
  repo: RepoRecord;
  workspaceId: string;
  created: boolean;
}

export interface CommandListReposResult {
  kind: "listRepos";
  repos: RepoRecord[];
}

export interface CommandRemoveRepoResult {
  kind: "removeRepo";
  repoId: string;
  rootPath: string;
}

export interface CommandListWorkspacesResult {
  kind: "listWorkspaces";
  workspaces: WorkspaceRecord[];
  archivedOnly: boolean;
}

export interface CommandArchiveWorkspaceResult {
  kind: "archiveWorkspace";
  workspaceId: string;
  status: "archived";
  branch: string;
}

export interface CommandRestoreWorkspaceResult {
  kind: "restoreWorkspace";
  workspaceId: string;
  status: "active";
  branch: string;
  primaryRepoId: string | null;
}

export interface CommandRemoveWorkspaceResult {
  kind: "removeWorkspace";
  workspaceId: string;
  rootPath: string;
}

export interface CraigIndex {
  version: 2;
  workspaceRoot: string;
  repoIds: string[];
  workspaceIds: string[];
  taskIds: string[];
  jobIds: string[];
  createdAt: string;
  updatedAt: string;
}
