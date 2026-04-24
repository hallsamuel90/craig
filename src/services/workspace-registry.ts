import type {
  CommandArchiveWorkspaceResult,
  CommandListWorkspacesResult,
  CommandRestoreWorkspaceResult,
} from "../types/command.js";
import type { CraigPaths } from "../state/craig-paths.js";
import { readCraigIndex, writeCraigIndex } from "../state/state-store.js";
import {
  deleteWorkspace,
  readWorkspace,
  listWorkspaceRecords,
  writeWorkspace,
} from "../state/workspace-store.js";
import { getDefaultUiState, readUiState, writeUiState } from "../state/ui-state-store.js";

export async function listWorkspaces(
  paths: CraigPaths,
  options: { archived: boolean },
): Promise<CommandListWorkspacesResult> {
  const workspaces = await listWorkspaceRecords(paths);

  return {
    kind: "listWorkspaces",
    workspaces: workspaces.filter((workspace) => workspace.status === (options.archived ? "archived" : "active")),
    archivedOnly: options.archived,
  };
}

export async function archiveWorkspace(paths: CraigPaths, workspaceId: string): Promise<CommandArchiveWorkspaceResult> {
  const workspace = await readWorkspace(paths, workspaceId);
  const archived = {
    ...workspace,
    status: "archived" as const,
    archivedAt: new Date().toISOString(),
  };

  await writeWorkspace(paths, archived);
  await clearUiSelection(paths, workspaceId);

  return {
    kind: "archiveWorkspace",
    workspaceId: archived.id,
    status: archived.status,
    branch: archived.branch,
  };
}

export async function restoreWorkspace(paths: CraigPaths, workspaceId: string): Promise<CommandRestoreWorkspaceResult> {
  const workspace = await readWorkspace(paths, workspaceId);
  const restored = {
    ...workspace,
    status: "active" as const,
    archivedAt: null,
  };

  await writeWorkspace(paths, restored);
  const ui = (await readUiState({ uiStateFile: paths.uiStateFile })) ?? null;

  await writeUiState(
    { uiStateFile: paths.uiStateFile },
      {
        ...(ui ?? getDefaultUiState()),
        selectedWorkspaceId: restored.id,
        selectedRepoId: restored.primaryRepoId,
        selectedTaskId: null,
        activeSurface: "overlay",
      },
  );

  return {
    kind: "restoreWorkspace",
    workspaceId: restored.id,
    status: restored.status,
    branch: restored.branch,
  };
}

export async function removeWorkspaceRecord(paths: CraigPaths, workspaceId: string): Promise<void> {
  await deleteWorkspace(paths, workspaceId);
  const index = await readCraigIndex(paths);

  await writeCraigIndex(paths, {
    ...index,
    workspaceIds: index.workspaceIds.filter((id) => id !== workspaceId),
  });
}

async function clearUiSelection(paths: CraigPaths, workspaceId: string): Promise<void> {
  const ui = await readUiState({ uiStateFile: paths.uiStateFile });

  if (!ui || ui.selectedWorkspaceId !== workspaceId) {
    return;
  }

  await writeUiState(
    { uiStateFile: paths.uiStateFile },
      {
        ...ui,
        selectedWorkspaceId: null,
        selectedRepoId: null,
        selectedTaskId: null,
        overlayMode: "archives",
      },
  );
}
