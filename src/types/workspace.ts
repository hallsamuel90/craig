import type { RunnerType } from "../domain/config/index.js";

export type { RepoRecord, WorkspaceStatus, WorkspaceRecord } from "../domain/workspace/index.js";

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
