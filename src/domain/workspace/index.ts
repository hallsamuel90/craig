export type {
  RepoRecord,
  WorkspaceStatus,
  WorkspaceRecord,
  CraigIndex,
  CommandCreateWorkspaceResult,
  CommandCreateRepoResult,
  CommandListReposResult,
  CommandRemoveRepoResult,
  CommandListWorkspacesResult,
  CommandArchiveWorkspaceResult,
  CommandRestoreWorkspaceResult,
  CommandRemoveWorkspaceResult,
} from "./types.js";
export { validateWorkspaceRecord, listWorkspaceRecords } from "./adapters/workspace-store.js";
export { validateRepoRecord, readRepo } from "./adapters/repo-store.js";
export { validateCraigIndex, readCraigIndex, writeCraigIndex } from "./adapters/index-store.js";

import { addWorkspace, listWorkspaces, archiveWorkspace, restoreWorkspace, removeWorkspace, removeWorkspaceRecord } from "./workspaces/index.js";
import * as repos from "./repos/index.js";

export const workspaceService = {
  addWorkspace,
  listWorkspaces,
  archiveWorkspace,
  restoreWorkspace,
  removeWorkspace,
  removeWorkspaceRecord,
  repos,
};
