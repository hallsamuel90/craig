import path from "node:path";

import type { CommandCreateTaskResult } from "../../../types/command.js";
import type { TaskRecord } from "../../../types/task.js";
import type { CraigPaths } from "../../../state/craig-paths.js";
import { configService } from "../../config/index.js";
import type { RunnerType } from "../../config/index.js";
import { writeSession } from "../adapters/session.js";
import { writeTask } from "../adapters/task-store.js";
import { commandRunnerAdapter, tmuxSessionManager } from "../adapters/runner.js";
import { provisionProjectTask, provisionTask } from "./provision.js";

export const createTask = async (
  paths: CraigPaths,
  repoIdOrWorkspaceId: string,
  prompt: string,
  options: { runner?: RunnerType; workspaceId?: string } = {},
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
    ? await provisionProjectTask(paths, options.workspaceId, trimmedPrompt, { runner, config })
    : await provisionTask(paths, repoIdOrWorkspaceId, trimmedPrompt, { runner, config });
  const draftTask = provisioned.task;
  const runnerCommand = configService.runners.buildCommand(runner, trimmedPrompt, config);
  const sessionId = `session_${draftTask.id}`;
  const logPath = draftTask.artifacts.logPath
    ? path.resolve(paths.workspaceRoot, draftTask.artifacts.logPath)
    : path.join(paths.logsDir, `${draftTask.id}.log`);

  try {
    await commandRunnerAdapter.prepare(draftTask, { repoRoot: provisioned.repoRoot });

    let session = await tmuxSessionManager.create(paths, {
      sessionId,
      taskId: draftTask.id,
      repoId: provisioned.repoId,
      workspaceId: provisioned.workspaceId,
      repoRoot: provisioned.repoRoot,
      worktreePath: draftTask.worktreePath,
      logPath,
      command: runnerCommand,
    });
    await commandRunnerAdapter.launch(draftTask, { repoRoot: provisioned.repoRoot, session });

    const startedAt = new Date().toISOString();
    session = {
      ...session,
      status: "running",
      startedAt,
      command: runnerCommand,
    };

    const runningTask: TaskRecord = {
      ...draftTask,
      status: "running",
      runner,
      sessionId: session.id,
      selectedPtyTabId: draftTask.selectedPtyTabId,
      runnerSession: {
        command: session.command,
        pid: null,
        startedAt,
        lastKnownState: "running",
        exitCode: null,
        exitedAt: null,
      },
    };

    await writeTask(paths, runningTask);
    await writeSession(paths, session);

    return {
      kind: "createTask",
      taskId: runningTask.id,
      repoId: runningTask.repoId,
      workspaceId: runningTask.workspaceId,
      sessionId: session.id,
      status: runningTask.status,
      branch: runningTask.branch,
      worktreePath: runningTask.worktreePath,
      runner: runningTask.runner,
    };
  } catch (error) {
    const failedTask: TaskRecord = {
      ...draftTask,
      sessionId: null,
      status: "draft",
      runnerSession: {
        ...draftTask.runnerSession,
        lastKnownState: "failed",
      },
      lastFailureReason: error instanceof Error ? error.message : "Unknown Craig error",
    };
    await writeTask(paths, failedTask);
    throw error;
  }
};
