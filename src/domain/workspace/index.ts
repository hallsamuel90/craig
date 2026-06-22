export type { RepoRecord, WorkspaceStatus, WorkspaceRecord, CraigIndex } from "./types.js";
export { validateWorkspaceRecord, listWorkspaceRecords } from "./adapters/workspace-store.js";
export { validateRepoRecord } from "./adapters/repo-store.js";
export { validateCraigIndex } from "./adapters/index-store.js";
export { ensureCraigState } from "./workspaces/ensure.js";

import * as workspaces from "./workspaces/index.js";
import * as repos from "./repos/index.js";

export const workspaceService = { workspaces, repos };
