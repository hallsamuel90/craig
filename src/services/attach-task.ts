import type { CommandAttachTaskResult } from "../types/command.js";
import type { CraigPaths } from "../state/craig-paths.js";
import { readRepo } from "../domain/workspace/adapters/repo-store.js";
import { readSession } from "../state/session-store.js";
import { tmuxSessionManager } from "./session-manager.js";
import { getTaskOrThrow } from "./task-inspection.js";

export async function attachTask(paths: CraigPaths, taskId: string): Promise<CommandAttachTaskResult> {
  const task = await getTaskOrThrow(paths, taskId);

  if (!task.sessionId) {
    throw new Error(`Task ${task.id} does not have a Craig session to attach.`);
  }

  const [repo, session] = await Promise.all([readRepo(paths, task.repoId), readSession(paths, task.sessionId)]);
  const attached = await tmuxSessionManager.attach(paths, session, repo.rootPath);

  return {
    kind: "attachTask",
    taskId: task.id,
    sessionId: attached.id,
    disposition: "attached",
  };
}
