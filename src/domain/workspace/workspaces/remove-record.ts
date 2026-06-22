import type { CraigPaths } from "../../../state/craig-paths.js";
import { readCraigIndex, writeCraigIndex } from "../adapters/index-store.js";
import { deleteWorkspace } from "../adapters/workspace-store.js";

export const removeWorkspaceRecord = async (
  paths: CraigPaths,
  workspaceId: string,
  deps: {
    deleteWorkspace: typeof deleteWorkspace;
    readCraigIndex: typeof readCraigIndex;
    writeCraigIndex: typeof writeCraigIndex;
  } = { deleteWorkspace, readCraigIndex, writeCraigIndex },
): Promise<void> => {
  await deps.deleteWorkspace(paths, workspaceId);
  const index = await deps.readCraigIndex(paths);
  await deps.writeCraigIndex(paths, {
    ...index,
    workspaceIds: index.workspaceIds.filter((id) => id !== workspaceId),
  });
};
