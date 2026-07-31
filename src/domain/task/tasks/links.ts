import type { CommandAddTaskLinkResult, CommandListTaskLinksResult } from "../types.js";
import type { CraigPaths } from "../../../state/craig-paths.js";
import { readRepo } from "../../../domain/workspace/index.js";
import { mutateTask } from "../adapters/task-store.js";
import { getTask } from "./inspect.js";

export const addTaskLink = async (
  paths: CraigPaths,
  taskId: string,
  repoId: string,
): Promise<CommandAddTaskLinkResult> => {
  const repo = await readRepo(paths, repoId);
  const task = await mutateTask(paths, taskId, (current) => {
    if (current.repoId === repo.id) {
      throw new Error(`Repo ${repo.id} is already the primary repo for task ${current.id}.`);
    }
    return {
      ...current,
      linkedRepoIds: current.linkedRepoIds.includes(repo.id)
        ? current.linkedRepoIds
        : [...current.linkedRepoIds, repo.id],
    };
  });

  return {
    kind: "addTaskLink",
    taskId: task.id,
    repoId: repo.id,
    linkedRepoIds: task.linkedRepoIds,
  };
};

export const listTaskLinks = async (paths: CraigPaths, taskId: string): Promise<CommandListTaskLinksResult> => {
  const task = await getTask(paths, taskId);
  const repos = await Promise.all(task.linkedRepoIds.map((repoId) => readRepo(paths, repoId)));

  return {
    kind: "listTaskLinks",
    taskId: task.id,
    repos,
  };
};
