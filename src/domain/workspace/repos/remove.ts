import type { CraigPaths } from "../../../state/craig-paths.js";
import { readUiState, writeUiState } from "../../../state/ui-state-store.js";
import type { CommandRemoveRepoResult } from "../../../types/command.js";
import { readCraigIndex, writeCraigIndex } from "../adapters/index-store.js";
import { deleteRepo, readRepo } from "../adapters/repo-store.js";
import { listWorkspaceRecords } from "../adapters/workspace-store.js";
import { removeWorkspaceRecord } from "../workspaces/remove-record.js";
import { listTasks } from "../../../services/list-tasks.js";

export const removeRepo = async (paths: CraigPaths, repoId: string): Promise<CommandRemoveRepoResult> => {
  const repo = await readRepo(paths, repoId);
  const workspaces = await listWorkspaceRecords(paths);
  const referencing = workspaces.filter((workspace) => workspace.primaryRepoId === repoId);
  const activeReferences = referencing.filter((workspace) => workspace.status === "active");
  const tasks = await listTasks(paths, { repoId });

  if (activeReferences.length > 0) {
    throw new Error(`Cannot remove repo ${repoId} while active workspace records still reference it.`);
  }

  if (tasks.tasks.length > 0) {
    throw new Error(`Cannot remove repo ${repoId} while task records still reference it.`);
  }

  await Promise.all(referencing.map((workspace) => removeWorkspaceRecord(paths, workspace.id)));
  await deleteRepo(paths, repoId);
  const index = await readCraigIndex(paths);

  await writeCraigIndex(paths, {
    ...index,
    repoIds: index.repoIds.filter((id) => id !== repoId),
  });

  const ui = await readUiState({ uiStateFile: paths.uiStateFile });

  if (ui?.selectedRepoId === repoId) {
    await writeUiState(
      { uiStateFile: paths.uiStateFile },
      { ...ui, selectedRepoId: null, selectedWorkspaceId: null, selectedTaskId: null },
    );
  }

  return { kind: "removeRepo", repoId: repo.id, rootPath: repo.rootPath };
};
