import type { RunnerType } from "./task.js";

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

export interface CraigUiRuntime {
  version: 1;
  selectedRepoId: string | null;
  selectedWorkspaceId: string | null;
  selectedTaskId: string | null;
  selectedPtyTabId?: string | null;
  inputMode?: "control" | "terminal";
  focusedRegion?: "tasks" | "center" | "inspector" | "actions" | "tabs";
  activeTab?: string;
  preferredPtyTabKind?: "agent" | "terminal";
  inspectorSection?: "task" | "checks" | "pr" | "setup-run" | "actions" | "next-action";
  inspectionMode?: "diff" | "files" | "review" | "checks" | "actions";
  openInspectionKind?: "file" | "diff" | null;
  selectedFileTreePath?: string | null;
  selectedFilePath?: string | null;
  selectedDiffPath?: string | null;
  collapsedFileTreePaths?: string[];
  selectedActionId?: "commit" | "push" | "refresh-checks" | "close-task";
  selectedRunner?: RunnerType;
  updatedAt: string;
}
