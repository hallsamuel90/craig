import { CraigError } from "../domain/error/index.js";
import {
  cancelTaskTree,
  createChildTask,
  type CommandCancelTreeResult,
  type CommandCreateChildResult,
  type CreateChildInput,
} from "../domain/orchestration/index.js";
import { configService } from "../domain/config/index.js";
import { taskService } from "../domain/task/index.js";
import type { CraigPaths } from "../state/craig-paths.js";
import { disposeDaemonSessions, ensureDaemonAgentSession } from "./pty-daemon-orchestration.js";

export async function createChildTaskAndSession(
  paths: CraigPaths,
  input: CreateChildInput,
): Promise<CommandCreateChildResult> {
  return createChildTask(paths, input, { createTask: createDaemonOwnedTask });
}

async function createDaemonOwnedTask(
  paths: CraigPaths,
  repoId: string,
  prompt: string,
  options: Parameters<typeof taskService.createTask>[3] = {},
): Promise<{ taskId: string }> {
  const config = await configService.load(paths);
  const runner = options.runner ?? configService.runners.getDefault(config);
  configService.runners.assertEnabled(runner, config);
  const provisioned = await taskService.provisionTask(paths, repoId, prompt, {
    runner,
    config,
    ...(options.lineage ? { lineage: options.lineage } : {}),
  });
  try {
    const launchEnvironment = await options.onProvisioned?.(provisioned.task);
    const task = await taskService.getTask(paths, provisioned.task.id);
    const agentTab = task.ptyTabs.find((tab) => tab.kind === "agent");
    if (!agentTab) throw new Error(`Task ${task.id} is missing its agent PTY tab.`);
    await ensureDaemonAgentSession(paths, {
      taskId: task.id,
      tabId: agentTab.id,
      cwd: task.worktreePath,
      command: task.runnerSession.command,
      ...(launchEnvironment ? { env: launchEnvironment } : {}),
    });
    const started = await taskService.markTaskStarted(paths, task.id);
    return { taskId: started.id };
  } catch (error) {
    await taskService.recordStartupFailure(
      paths,
      provisioned.task.id,
      error instanceof Error ? error.message : "Failed to start delegated agent.",
    );
    throw error;
  }
}

export async function cancelTaskTreeAndSessions(
  paths: CraigPaths,
  taskId: string,
  capabilityId?: string,
): Promise<CommandCancelTreeResult> {
  const tasks = (await taskService.listTasks(paths, { includeClosed: true })).tasks;
  const subtreeIds = new Set([taskId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const task of tasks) {
      if (task.parentTaskId && subtreeIds.has(task.parentTaskId) && !subtreeIds.has(task.id)) {
        subtreeIds.add(task.id);
        changed = true;
      }
    }
  }
  const tabIds = tasks
    .filter((task) => subtreeIds.has(task.id))
    .flatMap((task) => task.ptyTabs.map((tab) => tab.id));
  try {
    const result = await cancelTaskTree(paths, taskId, capabilityId);
    await disposeDaemonSessions(paths, tabIds);
    return result;
  } catch (error) {
    if (error instanceof CraigError && error.code === "PARTIAL_RESULT" && error.details.persisted === true) {
      await disposeDaemonSessions(paths, tabIds);
    }
    throw error;
  }
}
