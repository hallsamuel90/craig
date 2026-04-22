import type { TaskRecord, TaskStatus } from "../types/task.js";

const NON_TERMINAL_PRIORITY: TaskStatus[] = [
  "merge_ready",
  "pr_open",
  "checked",
  "review",
  "running",
  "draft",
];

export function sortTasksForDisplay(tasks: TaskRecord[]): TaskRecord[] {
  return [...tasks].sort((left, right) => left.id.localeCompare(right.id));
}

export function resolveSelectedTaskId(
  tasks: TaskRecord[],
  previousSelectedTaskId: string | null,
): string | null {
  if (previousSelectedTaskId && tasks.some((task) => task.id === previousSelectedTaskId)) {
    return previousSelectedTaskId;
  }

  if (tasks.length === 0) {
    return null;
  }

  const prioritized = [...tasks].sort(compareTaskPriority);

  return prioritized[0]?.id ?? null;
}

function compareTaskPriority(left: TaskRecord, right: TaskRecord): number {
  const leftRank = getTaskPriorityRank(left.status);
  const rightRank = getTaskPriorityRank(right.status);

  if (leftRank !== rightRank) {
    return leftRank - rightRank;
  }

  return right.updatedAt.localeCompare(left.updatedAt);
}

function getTaskPriorityRank(status: TaskStatus): number {
  const nonTerminalIndex = NON_TERMINAL_PRIORITY.indexOf(status);

  if (nonTerminalIndex >= 0) {
    return nonTerminalIndex;
  }

  return NON_TERMINAL_PRIORITY.length;
}
