import type { CommandAddTaskLinkResult, CommandListTaskLinksResult } from "../../../types/command.js";
import type { CraigPaths } from "../../../state/craig-paths.js";
import { readRepo } from "../../../domain/workspace/index.js";
import { writeTask } from "../adapters/task-store.js";
import { getTask } from "./inspect.js";

export const addTaskLink = async (
  paths: CraigPaths,
  taskId: string,
  repoId: string,
): Promise<CommandAddTaskLinkResult> => {
  const [task, repo] = await Promise.all([getTask(paths, taskId), readRepo(paths, repoId)]);

  if (task.repoId === repo.id) {
    throw new Error(`Repo ${repo.id} is already the primary repo for task ${task.id}.`);
  }

  const linkedRepoIds = task.linkedRepoIds.includes(repo.id) ? task.linkedRepoIds : [...task.linkedRepoIds, repo.id];
  await writeTask(paths, {
    ...task,
    linkedRepoIds,
  });

  return {
    kind: "addTaskLink",
    taskId: task.id,
    repoId: repo.id,
    linkedRepoIds,
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
