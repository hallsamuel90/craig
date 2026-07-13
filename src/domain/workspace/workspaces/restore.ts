import type { CraigPaths } from "../../../state/craig-paths.js";
import type { CommandRestoreWorkspaceResult } from "../types.js";
import { readWorkspace, writeWorkspace } from "../adapters/workspace-store.js";

export const restoreWorkspace = async (paths: CraigPaths, workspaceId: string): Promise<CommandRestoreWorkspaceResult> => {
  const workspace = await readWorkspace(paths, workspaceId);
  const restored = { ...workspace, status: "active" as const, archivedAt: null };

  await writeWorkspace(paths, restored);

  const primaryRepoId = restored.kind === "project"
    ? (restored.discoveredRepoIds?.[0] ?? null)
    : restored.primaryRepoId;

  return { kind: "restoreWorkspace", workspaceId: restored.id, status: restored.status, branch: restored.branch, primaryRepoId };
};
