import type { CommandAttachTaskResult } from "../../../commands/types.js";
import type { CraigPaths } from "../../../state/craig-paths.js";
import { readRepo } from "../../../domain/workspace/index.js";
import { readSession } from "../adapters/session.js";
import { tmuxSessionManager } from "../adapters/runner.js";
import { getTask } from "./inspect.js";

export const attachTask = async (paths: CraigPaths, taskId: string): Promise<CommandAttachTaskResult> => {
  const task = await getTask(paths, taskId);

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
};
