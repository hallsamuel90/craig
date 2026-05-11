import path from "node:path";

import type { CommandCreateTaskResult } from "../types/command.js";
import type { TaskRecord } from "../types/task.js";
import type { CraigPaths } from "../state/craig-paths.js";
import { writeSession } from "../state/session-store.js";
import { writeTask } from "../state/task-store.js";
import { readUiState, writeUiState, getDefaultUiState } from "../state/ui-state-store.js";
import { codexRunnerAdapter } from "./codex-runner.js";
import { tmuxSessionManager } from "./session-manager.js";
import { provisionTask } from "./task-provisioning.js";
import { getTaskBundlePath } from "./task-worktrees.js";

export async function createTask(
  paths: CraigPaths,
  repoId: string,
  prompt: string,
  options: { linkedRepoIds?: string[] } = {},
): Promise<CommandCreateTaskResult> {
  const trimmedPrompt = prompt.trim();

  if (repoId.trim().length === 0) {
    throw new Error("Repo id cannot be empty.");
  }

  if (trimmedPrompt.length === 0) {
    throw new Error("Task prompt cannot be empty.");
  }
  const provisioned = await provisionTask(paths, repoId, trimmedPrompt, { linkedRepoIds: options.linkedRepoIds ?? [] });
  const draftTask = provisioned.task;
  const sessionId = `session_${draftTask.id}`;
  const logPath = draftTask.artifacts.logPath
    ? path.resolve(paths.workspaceRoot, draftTask.artifacts.logPath)
    : path.join(paths.logsDir, `${draftTask.id}.log`);

  try {
    await codexRunnerAdapter.prepare(draftTask, { repoRoot: provisioned.repoRoot });

    let session = await tmuxSessionManager.create(paths, {
      sessionId,
      taskId: draftTask.id,
      repoId: provisioned.repoId,
      workspaceId: provisioned.workspaceId,
      repoRoot: provisioned.repoRoot,
      worktreePath: getTaskBundlePath(draftTask),
      logPath,
      command: ["codex", trimmedPrompt],
    });
    await codexRunnerAdapter.launch(draftTask, { repoRoot: provisioned.repoRoot, session });

    const startedAt = new Date().toISOString();
    session = {
      ...session,
      status: "running",
      startedAt,
      command: ["codex", trimmedPrompt],
    };

    const runningTask: TaskRecord = {
      ...draftTask,
      status: "running",
      runner: "codex",
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
    await writeUiState(
      { uiStateFile: paths.uiStateFile },
      {
        ...((await readUiState({ uiStateFile: paths.uiStateFile })) ?? getDefaultUiState()),
        selectedRepoId: runningTask.repoId,
        selectedWorkspaceId: runningTask.workspaceId,
        selectedTaskId: runningTask.id,
        selectedPtyTabId: runningTask.selectedPtyTabId,
      },
    );

    return {
      kind: "createTask",
      taskId: runningTask.id,
      repoId: runningTask.repoId,
      linkedRepoIds: runningTask.linkedRepoIds,
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
}
