import type { CraigPaths } from "../../../state/craig-paths.js";
import type { CommandArchiveWorkspaceResult } from "../../../types/command.js";
import { readWorkspace, writeWorkspace } from "../adapters/workspace-store.js";

export const archiveWorkspace = async (
  paths: CraigPaths,
  workspaceId: string,
  deps: {
    readWorkspace: typeof readWorkspace;
    writeWorkspace: typeof writeWorkspace;
  } = { readWorkspace, writeWorkspace },
): Promise<CommandArchiveWorkspaceResult> => {
  const workspace = await deps.readWorkspace(paths, workspaceId);
  const archived = { ...workspace, status: "archived" as const, archivedAt: new Date().toISOString() };

  await deps.writeWorkspace(paths, archived);

  return { kind: "archiveWorkspace", workspaceId: archived.id, status: archived.status, branch: archived.branch };
};
