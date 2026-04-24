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
  primaryRepoId: string;
  branch: string;
  status: WorkspaceStatus;
  linkedRepoIds: string[];
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type OverlayMode = "start" | "archives";

export interface CraigUiRuntime {
  version: 1;
  selectedRepoId: string | null;
  selectedWorkspaceId: string | null;
  selectedTaskId: string | null;
  activeSurface: "overlay";
  overlayMode: OverlayMode;
  updatedAt: string;
}
