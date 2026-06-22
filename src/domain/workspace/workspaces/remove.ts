import type { CraigPaths } from "../../../state/craig-paths.js";
import { readUiState, writeUiState } from "../../../state/ui-state-store.js";
import type { CommandRemoveWorkspaceResult } from "../../../types/command.js";
import { readWorkspace } from "../adapters/workspace-store.js";
import { removeWorkspaceRecord } from "./remove-record.js";
import { listTasks } from "../../../services/list-tasks.js";

const clearUiSelection = async (paths: CraigPaths, workspaceId: string): Promise<void> => {
  const ui = await readUiState({ uiStateFile: paths.uiStateFile });
  if (!ui || ui.selectedWorkspaceId !== workspaceId) return;
  await writeUiState(
    { uiStateFile: paths.uiStateFile },
    { ...ui, selectedWorkspaceId: null, selectedRepoId: null, selectedTaskId: null },
  );
};

export const removeWorkspace = async (paths: CraigPaths, workspaceId: string): Promise<CommandRemoveWorkspaceResult> => {
  const workspace = await readWorkspace(paths, workspaceId);
  const tasks = await listTasks(paths, { workspaceId, includeClosed: true });

  if (workspace.status === "active") {
    throw new Error(`Cannot remove workspace ${workspaceId} while it is active. Archive it first.`);
  }

  if (tasks.tasks.length > 0) {
    throw new Error(`Cannot remove workspace ${workspaceId} while task records still reference it.`);
  }

  await removeWorkspaceRecord(paths, workspaceId);
  await clearUiSelection(paths, workspaceId);

  return { kind: "removeWorkspace", workspaceId: workspace.id, rootPath: workspace.rootPath ?? "" };
};
