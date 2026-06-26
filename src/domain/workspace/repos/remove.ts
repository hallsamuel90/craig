import type { CraigPaths } from "../../../state/craig-paths.js";
import type { CommandListResult, CommandRemoveRepoResult } from "../../../types/command.js";
import { readCraigIndex, writeCraigIndex } from "../adapters/index-store.js";
import { deleteRepo, readRepo } from "../adapters/repo-store.js";
import { listWorkspaceRecords } from "../adapters/workspace-store.js";
import { removeWorkspaceRecord } from "../workspaces/remove-record.js";

type ListTasksFn = (paths: CraigPaths, filter: { repoId: string }) => Promise<CommandListResult>; // eslint-disable-line no-unused-vars

export const removeRepo = async (
  paths: CraigPaths,
  repoId: string,
  deps: { listTasks: ListTasksFn },
): Promise<CommandRemoveRepoResult> => {
  const repo = await readRepo(paths, repoId);
  const workspaces = await listWorkspaceRecords(paths);
  const referencing = workspaces.filter((workspace) => workspace.primaryRepoId === repoId);
  const activeReferences = referencing.filter((workspace) => workspace.status === "active");
  const tasks = await deps.listTasks(paths, { repoId });

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

  return { kind: "removeRepo", repoId: repo.id, rootPath: repo.rootPath };
};
