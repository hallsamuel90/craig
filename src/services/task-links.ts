import type { CommandAddTaskLinkResult, CommandListTaskLinksResult } from "../types/command.js";
import type { CraigPaths } from "../state/craig-paths.js";
import { readRepo } from "../state/repo-store.js";
import { writeTask } from "../state/task-store.js";
import { getTaskOrThrow } from "./task-inspection.js";

export async function addTaskLink(
  paths: CraigPaths,
  taskId: string,
  repoId: string,
): Promise<CommandAddTaskLinkResult> {
  const [task, repo] = await Promise.all([getTaskOrThrow(paths, taskId), readRepo(paths, repoId)]);

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
}

export async function listTaskLinks(paths: CraigPaths, taskId: string): Promise<CommandListTaskLinksResult> {
  const task = await getTaskOrThrow(paths, taskId);
  const repos = await Promise.all(task.linkedRepoIds.map((repoId) => readRepo(paths, repoId)));

  return {
    kind: "listTaskLinks",
    taskId: task.id,
    repos,
  };
}
