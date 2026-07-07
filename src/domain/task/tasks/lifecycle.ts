import type { CraigPaths } from "../../../state/craig-paths.js";
import type { TaskRecord } from "../types.js";
import { readTask, writeTask } from "../adapters/task-store.js";

export const markRunnerFailed = async (paths: CraigPaths, taskId: string, message: string): Promise<void> => {
  const task = await readTask(paths, taskId);
  await writeTask(paths, {
    ...task,
    status: task.status === "running" ? "draft" : task.status,
    runnerSession: {
      ...task.runnerSession,
      lastKnownState: "failed",
      exitedAt: new Date().toISOString(),
    },
    lastFailureReason: message,
  });
};

export const recordStartupFailure = async (paths: CraigPaths, taskId: string, message: string): Promise<TaskRecord> => {
  const task = await readTask(paths, taskId);
  const failed: TaskRecord = {
    ...task,
    status: "draft",
    runnerSession: {
      ...task.runnerSession,
      lastKnownState: "failed",
      exitedAt: new Date().toISOString(),
    },
    lastFailureReason: message,
  };
  await writeTask(paths, failed);
  return failed;
};

export const markTaskStarted = async (paths: CraigPaths, taskId: string): Promise<TaskRecord> => {
  const task = await readTask(paths, taskId);
  const agentTab = task.ptyTabs.find((t) => t.kind === "agent");
  if (!agentTab) {
    throw new Error(`Task ${taskId} is missing its agent PTY tab.`);
  }
  const running: TaskRecord = {
    ...task,
    status: "running",
    selectedPtyTabId: agentTab.id,
    runnerSession: {
      ...task.runnerSession,
      startedAt: new Date().toISOString(),
      lastKnownState: "running",
    },
  };
  await writeTask(paths, running);
  return running;
};
