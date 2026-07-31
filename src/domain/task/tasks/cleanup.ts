import type { CraigPaths } from "../../../state/craig-paths.js";
import { readSession } from "../adapters/session.js";
import { mutateTask } from "../adapters/task-store.js";
import { removeWorktree } from "../adapters/git.js";
import { killSession } from "../adapters/tmux.js";
import type { TaskRecord } from "../types.js";

export const cleanupTask = async (
  paths: CraigPaths,
  task: TaskRecord,
  options: { preserveWorktree: boolean },
): Promise<void> => {
  const warnings: string[] = [];
  let paneClosedAt: string | null = null;
  let worktreeRemovedAt: string | null = null;

  try {
    if (task.sessionId) {
      const session = await readSession(paths, task.sessionId);
      await killSession(paths.repoRoot, session.sessionName);
      paneClosedAt = new Date().toISOString();
    }
  } catch (error) {
    warnings.push(error instanceof Error ? error.message : "Failed to close tmux session.");
  }

  if (!options.preserveWorktree) {
    try {
      await removeWorktree(paths.repoRoot, task.worktreePath);
      worktreeRemovedAt = new Date().toISOString();
    } catch (error) {
      warnings.push(error instanceof Error ? error.message : "Failed to remove worktree.");
    }
  }

  await mutateTask(paths, task.id, (current) => ({
    ...current,
    cleanup: {
      ...current.cleanup,
      paneClosedAt: paneClosedAt ?? current.cleanup.paneClosedAt,
      worktreeRemovedAt: worktreeRemovedAt ?? current.cleanup.worktreeRemovedAt,
      preservedWorktree: options.preserveWorktree,
      warning: warnings.length > 0 ? warnings.join(" ") : null,
    },
  }));
};
