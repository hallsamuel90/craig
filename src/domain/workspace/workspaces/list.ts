import type { CraigPaths } from "../../../state/craig-paths.js";
import type { CommandListWorkspacesResult } from "../../../types/command.js";
import { listWorkspaceRecords } from "../adapters/workspace-store.js";

export const listWorkspaces = async (
  paths: CraigPaths,
  options: { archived: boolean },
  deps: { listWorkspaceRecords: typeof listWorkspaceRecords } = { listWorkspaceRecords },
): Promise<CommandListWorkspacesResult> => {
  const workspaces = await deps.listWorkspaceRecords(paths);
  return {
    kind: "listWorkspaces",
    workspaces: workspaces.filter((workspace) => workspace.status === (options.archived ? "archived" : "active")),
    archivedOnly: options.archived,
  };
};
