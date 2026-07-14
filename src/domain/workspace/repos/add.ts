import path from "node:path";
import { stat } from "node:fs/promises";

import type { CraigPaths } from "../../../state/craig-paths.js";
import type { CommandCreateRepoResult } from "../types.js";
import { addWorkspace } from "../workspaces/add.js";

export const addRepo = async (paths: CraigPaths, rawPath: string): Promise<CommandCreateRepoResult> => {
  const rootPath = path.resolve(paths.workspaceRoot, rawPath);
  const stats = await stat(rootPath).catch(() => null);

  if (!stats?.isDirectory()) {
    throw new Error(`Repo path does not exist: ${rootPath}`);
  }

  const workspaceResult = await addWorkspace(paths, rawPath);
  const repo = workspaceResult.repos[0];

  if (!repo || workspaceResult.workspace.kind === "project") {
    throw new Error(`Repo path is not a git repository: ${rootPath}`);
  }

  return { kind: "createRepo", repo, workspaceId: workspaceResult.workspace.id, created: workspaceResult.created };
};
