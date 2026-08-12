import { CraigError } from "../domain/error/index.js";
import {
  cancelTaskTree,
  createChildTask,
  promptCommandService,
  type CommandCancelTreeResult,
  type CommandCreateChildResult,
  type CreateChildInput,
  createRootTask,
} from "../domain/orchestration/index.js";
import { taskService, type CommandCreateTaskResult, type TaskCreationOptions } from "../domain/task/index.js";
import type { CraigPaths } from "../state/craig-paths.js";
import { disposeDaemonSessions, ensureDaemonAgentSession } from "./pty-daemon-orchestration.js";
import { requirePromptCommandWake } from "./prompt-commands.js";

const INITIAL_PROMPT_TIMEOUT_MS = 60_000;

export async function createChildTaskAndSession(
  paths: CraigPaths,
  input: CreateChildInput,
): Promise<CommandCreateChildResult> {
  return createChildTask(paths, input, { createTask: createDaemonOwnedTask });
}

export async function createRootTaskAndSession(
  paths: CraigPaths,
  repoIdOrWorkspaceId: string,
  prompt: string,
  options: TaskCreationOptions = {},
): Promise<CommandCreateTaskResult> {
  return createRootTask(paths, repoIdOrWorkspaceId, prompt, {
    ...options,
    launchProvisioned: (task, environment) => launchDaemonTask(paths, task, environment, false),
  });
}

async function createDaemonOwnedTask(
  paths: CraigPaths,
  repoId: string,
  prompt: string,
  options: TaskCreationOptions = {},
): Promise<CommandCreateTaskResult> {
  return taskService.createTask(paths, repoId, prompt, {
    ...options,
    markStartedAfterLaunch: false,
    launchProvisioned: (task, environment) => launchDaemonTask(paths, task, environment, true),
  });
}

async function launchDaemonTask(
  paths: CraigPaths,
  task: Awaited<ReturnType<typeof taskService.getTask>>,
  environment?: Record<string, string>,
  durableInitialPrompt = false,
): Promise<void> {
  const agentTab = task.ptyTabs.find((tab) => tab.kind === "agent");
  if (!agentTab) throw new Error(`Task ${task.id} is missing its agent PTY tab.`);
  try {
    await ensureDaemonAgentSession(paths, {
      taskId: task.id,
      tabId: agentTab.id,
      cwd: task.worktreePath,
      command: durableInitialPrompt ? agentTab.command : task.runnerSession.command,
      ...(environment ? { env: environment } : {}),
    });
    if (!durableInitialPrompt) return;
    const initial = await promptCommandService.create(paths, {
      taskId: task.id,
      agentTabId: agentTab.id,
      prompt: { source: "inline", text: task.prompt.value },
      delivery: "when-ready",
      timeoutMs: INITIAL_PROMPT_TIMEOUT_MS,
      idempotencyKey: `task-start:${task.id}`,
      actor: { type: "system", component: "orchestration-supervisor" },
    });
    await requirePromptCommandWake(paths, initial.command.id);
  } catch (error) {
    await disposeDaemonSessions(paths, [agentTab.id]);
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
