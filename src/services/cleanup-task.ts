import type { CraigPaths } from "../state/craig-paths.js";
import { readSession } from "../state/session-store.js";
import { writeTask } from "../state/task-store.js";
import { removeWorktree } from "./git-task.js";
import { killSession } from "./tmux-session.js";

export async function cleanupTask(
  paths: CraigPaths,
  task: Parameters<typeof writeTask>[1],
  options: { preserveWorktree: boolean },
): Promise<void> {
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
}
