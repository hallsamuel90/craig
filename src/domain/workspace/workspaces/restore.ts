import type { CraigPaths } from "../../../state/craig-paths.js";
import { getDefaultUiState, readUiState, writeUiState } from "../../../state/ui-state-store.js";
import type { CommandRestoreWorkspaceResult } from "../../../types/command.js";
import { readWorkspace, writeWorkspace } from "../adapters/workspace-store.js";

export const restoreWorkspace = async (paths: CraigPaths, workspaceId: string): Promise<CommandRestoreWorkspaceResult> => {
  const workspace = await readWorkspace(paths, workspaceId);
  const restored = { ...workspace, status: "active" as const, archivedAt: null };

  await writeWorkspace(paths, restored);
  const ui = (await readUiState({ uiStateFile: paths.uiStateFile })) ?? null;

  await writeUiState(
    { uiStateFile: paths.uiStateFile },
    {
      ...(ui ?? getDefaultUiState()),
      selectedWorkspaceId: restored.id,
      selectedRepoId: restored.kind === "project" ? (restored.discoveredRepoIds?.[0] ?? null) : restored.primaryRepoId,
      selectedTaskId: null,
    },
  );

  return { kind: "restoreWorkspace", workspaceId: restored.id, status: restored.status, branch: restored.branch };
};
