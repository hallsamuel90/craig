import type { CommandFocusResult } from "../../../types/command.js";
import type { CraigPaths } from "../../../state/craig-paths.js";
import { readSession } from "../adapters/session.js";
import { focusPane } from "../adapters/tmux.js";
import { getTask } from "./inspect.js";

export const focusTask = async (paths: CraigPaths, taskId: string): Promise<CommandFocusResult> => {
  const task = await getTask(paths, taskId);

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
};

const isFileMissingError = (error: unknown): error is { code: string } => {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof (error as { code?: unknown }).code === "string" &&
    (error as { code: string }).code === "ENOENT"
  );
};
