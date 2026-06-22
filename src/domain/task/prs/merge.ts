import type { CraigPaths } from "../../../state/craig-paths.js";
import { mergeGitHubPr } from "../adapters/github.js";
import { getTask } from "../tasks/inspect.js";
import { getTaskPrimaryPr } from "./state.js";

export const mergeTask = async (
  paths: CraigPaths,
  taskId: string,
  mergeMethod: "merge" | "rebase" | "squash" = "merge",
  prNumber?: number,
): Promise<void> => {
  const task = await getTask(paths, taskId);
  const number = prNumber ?? getTaskPrimaryPr(task)?.number;
  if (!number) {
    throw new Error(`Task ${task.id} has no pull request to merge.`);
  }

  await mergeGitHubPr(task.worktreePath, number, mergeMethod);
};
