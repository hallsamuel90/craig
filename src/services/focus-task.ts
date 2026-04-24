import type { CommandFocusResult } from "../types/command.js";
import type { CraigPaths } from "../state/craig-paths.js";
import { readSession } from "../state/session-store.js";
import { focusPane } from "./tmux-session.js";
import { getTaskOrThrow } from "./task-inspection.js";

export async function focusTask(paths: CraigPaths, taskId: string): Promise<CommandFocusResult> {
  const task = await getTaskOrThrow(paths, taskId);

  if (!task.sessionId) {
    throw new Error(`Task ${task.id} does not have a Craig session.`);
  }

  const session = await readSession(paths, task.sessionId).catch((error) => {
    if (isFileMissingError(error)) {
      throw new Error(`Task ${task.id} does not have a Craig session.`);
    }

    throw error;
  });

  if (!session.paneId) {
    throw new Error(`Task ${task.id} does not have a tmux target.`);
  }

  await focusPane(paths.repoRoot, session.paneId, session.windowTarget, session.sessionName);

  return {
    kind: "focusTask",
    taskId: task.id,
    tmuxTarget: session.paneId,
  };
}

function isFileMissingError(error: unknown): error is { code: string } {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    error.code === "ENOENT"
  );
}
