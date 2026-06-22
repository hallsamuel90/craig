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
