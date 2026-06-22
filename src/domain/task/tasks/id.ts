import { readCraigIndex } from "../../../state/state-store.js";
import type { CraigPaths } from "../../../state/craig-paths.js";
import { branchExists } from "../adapters/git.js";

export const allocateTaskId = async (paths: CraigPaths): Promise<string> => {
  return allocateTaskIdForRepo(paths, paths.repoRoot);
};

export const allocateTaskIdForRepo = async (paths: CraigPaths, repoRoot: string): Promise<string> => {
  const index = await readCraigIndex(paths);
  const dateSegment = formatDate(new Date());
  let sequence = nextSequence(index.taskIds, dateSegment);

  while (true) {
    const taskId = `task_${dateSegment}_${String(sequence).padStart(2, "0")}`;
    const branch = `craig/${taskId}`;

    if (!(await branchExists(repoRoot, branch))) {
      return taskId;
    }

    sequence += 1;
  }
};

export const allocateProjectTaskId = async (paths: CraigPaths): Promise<string> => {
  const index = await readCraigIndex(paths);
  const dateSegment = formatDate(new Date());
  const sequence = nextSequence(index.taskIds, dateSegment);
  return `task_${dateSegment}_${String(sequence).padStart(2, "0")}`;
};

const formatDate = (date: Date): string => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");

  return `${year}${month}${day}`;
};

const nextSequence = (taskIds: string[], dateSegment: string): number => {
  const matches = taskIds
    .filter((taskId) => taskId.startsWith(`task_${dateSegment}_`))
    .map((taskId) => Number.parseInt(taskId.slice(-2), 10))
    .filter((value) => Number.isInteger(value));

  return matches.length === 0 ? 1 : Math.max(...matches) + 1;
};
