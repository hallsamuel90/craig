import type { CraigPaths } from "../../../state/craig-paths.js";
import type { CommandListWorkspacesResult } from "../../../commands/types.js";
import { listWorkspaceRecords } from "../adapters/workspace-store.js";
import { ensureCraigState } from "./ensure.js";

export const listWorkspaces = async (
  paths: CraigPaths,
  options: { archived: boolean },
  deps: { listWorkspaceRecords: typeof listWorkspaceRecords; ensureCraigState: typeof ensureCraigState } = { listWorkspaceRecords, ensureCraigState },
): Promise<CommandListWorkspacesResult> => {
  await deps.ensureCraigState(paths.workspaceRoot);
  const workspaces = await deps.listWorkspaceRecords(paths);
  return {
    kind: "listWorkspaces",
    workspaces: workspaces.filter((workspace) => workspace.status === (options.archived ? "archived" : "active")),
    archivedOnly: options.archived,
  };
};
