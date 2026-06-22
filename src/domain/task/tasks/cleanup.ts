import type { CraigPaths } from "../../../state/craig-paths.js";
import { readSession } from "../adapters/session.js";
import { writeTask } from "../adapters/task-store.js";
import { removeWorktree } from "../adapters/git.js";
import { killSession } from "../adapters/tmux.js";
import type { TaskRecord } from "../../../types/task.js";

export const cleanupTask = async (
  paths: CraigPaths,
  task: TaskRecord,
  options: { preserveWorktree: boolean },
): Promise<void> => {
  const warnings: string[] = [];

  try {
    if (task.sessionId) {
      const session = await readSession(paths, task.sessionId);
      await killSession(paths.repoRoot, session.sessionName);
      task.cleanup.paneClosedAt = new Date().toISOString();
    }
  } catch (error) {
    warnings.push(error instanceof Error ? error.message : "Failed to close tmux session.");
  }

  task.cleanup.preservedWorktree = options.preserveWorktree;

  if (!options.preserveWorktree) {
    try {
      await removeWorktree(paths.repoRoot, task.worktreePath);
      task.cleanup.worktreeRemovedAt = new Date().toISOString();
    } catch (error) {
      warnings.push(error instanceof Error ? error.message : "Failed to remove worktree.");
    }
  }

  task.cleanup.warning = warnings.length > 0 ? warnings.join(" ") : null;
  await writeTask(paths, task);
};
