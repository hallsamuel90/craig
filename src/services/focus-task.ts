import type { CommandFocusResult } from "../types/command.js";
import type { CraigPaths } from "../state/craig-paths.js";
import { focusPane } from "./tmux-session.js";
import { getTaskOrThrow } from "./task-inspection.js";

export async function focusTask(paths: CraigPaths, taskId: string): Promise<CommandFocusResult> {
  const task = await getTaskOrThrow(paths, taskId);

  if (!task.tmuxTarget) {
    throw new Error(`Task ${task.id} does not have a tmux target.`);
  }

  await focusPane(paths.repoRoot, task.tmuxTarget);

  return {
    kind: "focusTask",
    taskId: task.id,
    tmuxTarget: task.tmuxTarget,
  };
}
