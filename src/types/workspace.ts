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

export interface CraigUiRuntime {
  version: 1;
  selectedRepoId: string | null;
  selectedWorkspaceId: string | null;
  selectedTaskId: string | null;
  selectedPtyTabId?: string | null;
  inputMode?: "control";
  focusedRegion?: "tasks" | "center" | "actions" | "tabs";
  activeTab?: "agent" | "files" | "diff" | "terminal" | "logs";
  selectedActionId?: "commit" | "push" | "create-pr" | "merge" | "close-task";
  updatedAt: string;
}
