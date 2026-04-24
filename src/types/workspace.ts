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
export type CraigInputMode = "control" | "terminal";
export type CraigActiveSurface = "overlay" | "shell";
export type CraigCenterSurface = "command" | "terminal";
export type CraigContextTab = "summary" | "logs" | "diff" | "files" | "review";
export type CraigPanelFocus = "left" | "center" | "right";

export interface CraigUiRuntime {
  version: 1;
  selectedRepoId: string | null;
  selectedWorkspaceId: string | null;
  selectedTaskId: string | null;
  activeSurface: CraigActiveSurface;
  overlayMode: OverlayMode;
  inputMode: CraigInputMode;
  centerSurface: CraigCenterSurface;
  rightContextTab: CraigContextTab;
  panelFocus: CraigPanelFocus;
  lastAttachedSessionId: string | null;
  commandBuffer: string;
  outputLines: string[];
  updatedAt: string;
}
