import type { CommandRenameTaskResult } from "../types.js";
import type { CraigPaths } from "../../../state/craig-paths.js";
import { mutateTask } from "../adapters/task-store.js";
import { slugifyTaskTitle } from "./title.js";

export const renameTask = async (
  paths: CraigPaths,
  taskId: string,
  title: string,
): Promise<CommandRenameTaskResult> => {
  const normalizedTitle = title.trim();
  if (normalizedTitle.length === 0) {
    throw new Error("Task title cannot be empty.");
  }

  let previousTitle = "";
  const task = await mutateTask(paths, taskId, (current) => {
    previousTitle = current.title;
    return {
      ...current,
      title: normalizedTitle,
      slug: slugifyTaskTitle(normalizedTitle),
    };
  });

  return {
    kind: "renameTask",
    taskId: task.id,
    previousTitle,
    title: task.title,
    slug: task.slug,
  };
};
