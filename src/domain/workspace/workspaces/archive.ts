import type { CraigPaths } from "../../../state/craig-paths.js";
import { readUiState, writeUiState } from "../../../state/ui-state-store.js";
import type { CommandArchiveWorkspaceResult } from "../../../types/command.js";
import { readWorkspace, writeWorkspace } from "../adapters/workspace-store.js";

export const archiveWorkspace = async (
  paths: CraigPaths,
  workspaceId: string,
  deps: {
    readWorkspace: typeof readWorkspace;
    writeWorkspace: typeof writeWorkspace;
    readUiState: typeof readUiState;
    writeUiState: typeof writeUiState;
  } = { readWorkspace, writeWorkspace, readUiState, writeUiState },
): Promise<CommandArchiveWorkspaceResult> => {
  const workspace = await deps.readWorkspace(paths, workspaceId);
  const archived = { ...workspace, status: "archived" as const, archivedAt: new Date().toISOString() };

  await deps.writeWorkspace(paths, archived);

  const ui = await deps.readUiState({ uiStateFile: paths.uiStateFile });
  if (ui && ui.selectedWorkspaceId === workspaceId) {
    await deps.writeUiState(
      { uiStateFile: paths.uiStateFile },
      { ...ui, selectedWorkspaceId: null, selectedRepoId: null, selectedTaskId: null },
    );
  }

  return { kind: "archiveWorkspace", workspaceId: archived.id, status: archived.status, branch: archived.branch };
};
