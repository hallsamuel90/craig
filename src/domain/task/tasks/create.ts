/* eslint-disable no-unused-vars */
import type { CommandCreateTaskResult } from "../types.js";
import type { TaskRecord } from "../types.js";
import type { CraigPaths } from "../../../state/craig-paths.js";
import { configService } from "../../config/index.js";
import type { RunnerType } from "../../config/index.js";
import { provisionProjectTask, provisionTask } from "./provision.js";
import type { TaskLineageInput } from "./provision.js";
import { markTaskStarted, recordStartupFailure } from "./lifecycle.js";

export interface TaskCreationOptions {
  runner?: RunnerType;
  workspaceId?: string;
  owningWorkspaceId?: string;
  lineage?: TaskLineageInput;
  onProvisioned?: (task: TaskRecord) => Promise<Record<string, string> | void>;
  launchProvisioned?: (task: TaskRecord, environment?: Record<string, string>) => Promise<void>;
}

export const createTask = async (
  paths: CraigPaths,
  repoIdOrWorkspaceId: string,
  prompt: string,
  options: TaskCreationOptions = {},
): Promise<CommandCreateTaskResult> => {
  const trimmedPrompt = prompt.trim();
  const config = await configService.load(paths);
  const runner = options.runner ?? configService.runners.getDefault(config);
  configService.runners.assertEnabled(runner, config);

  if (repoIdOrWorkspaceId.trim().length === 0) {
    throw new Error(options.workspaceId ? "Workspace id cannot be empty." : "Repo id cannot be empty.");
  }

  if (trimmedPrompt.length === 0) {
    throw new Error("Task prompt cannot be empty.");
  }
  const provisioned = options.workspaceId
    ? await provisionProjectTask(paths, options.workspaceId, trimmedPrompt, { runner, config, ...(options.lineage ? { lineage: options.lineage } : {}) })
    : await provisionTask(paths, repoIdOrWorkspaceId, trimmedPrompt, {
        runner,
        config,
        ...(options.owningWorkspaceId ? { workspaceId: options.owningWorkspaceId } : {}),
        ...(options.lineage ? { lineage: options.lineage } : {}),
      });
  const draftTask = provisioned.task;
  try {
    const launchEnvironment = await options.onProvisioned?.(draftTask);
    if (!options.launchProvisioned) throw new Error("Craig task creation requires the PTY daemon launcher.");
    await options.launchProvisioned(draftTask, launchEnvironment || undefined);
    const runningTask = await markTaskStarted(paths, draftTask.id);
    const agentTab = runningTask.ptyTabs.find((tab) => tab.kind === "agent")!;

    return {
      kind: "createTask",
      taskId: runningTask.id,
      repoId: runningTask.repoId,
      workspaceId: runningTask.workspaceId,
      agentTabId: agentTab.id,
      status: runningTask.status,
      branch: runningTask.branch,
      worktreePath: runningTask.worktreePath,
      runner: runningTask.runner,
    };
  } catch (error) {
    await recordStartupFailure(paths, draftTask.id, error instanceof Error ? error.message : "Unknown Craig error");
    throw error;
  }
};
