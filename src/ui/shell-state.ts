import type { TaskRecord } from "../types/task.js";
import type { ControlShellState } from "./state.js";

export function getSelectedTask(tasks: TaskRecord[], shell: ControlShellState): TaskRecord | null {
  return tasks.find((task) => task.id === shell.selectedTaskId) ?? null;
}
