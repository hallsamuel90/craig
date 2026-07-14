import type { CraigPaths } from "../../../state/craig-paths.js";
import type { CommandRemoveWorkspaceResult } from "../types.js";
import type { CommandListResult } from "../../task/types.js";
import { readWorkspace } from "../adapters/workspace-store.js";
import { removeWorkspaceRecord } from "./remove-record.js";

type ListTasksFn = (paths: CraigPaths, filter: { workspaceId: string; includeClosed: boolean }) => Promise<CommandListResult>; // eslint-disable-line no-unused-vars

export const removeWorkspace = async (
  paths: CraigPaths,
  workspaceId: string,
  deps: { listTasks: ListTasksFn },
): Promise<CommandRemoveWorkspaceResult> => {
  const workspace = await readWorkspace(paths, workspaceId);
  const tasks = await deps.listTasks(paths, { workspaceId, includeClosed: true });

  if (workspace.status === "active") {
    throw new Error(`Cannot remove workspace ${workspaceId} while it is active. Archive it first.`);
  }

  if (tasks.tasks.length > 0) {
    throw new Error(`Cannot remove workspace ${workspaceId} while task records still reference it.`);
  }

  await removeWorkspaceRecord(paths, workspaceId);

  return { kind: "removeWorkspace", workspaceId: workspace.id, rootPath: workspace.rootPath ?? "" };
};
