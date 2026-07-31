import type { CraigPaths } from "../../../state/craig-paths.js";
import type { TaskRecord } from "../types.js";
import { mutateTask } from "../adapters/task-store.js";

export const markRunnerFailed = async (paths: CraigPaths, taskId: string, message: string): Promise<void> => {
  await mutateTask(paths, taskId, (task) => ({
    ...task,
    status: task.status === "running" ? "draft" : task.status,
    runnerSession: {
      ...task.runnerSession,
      lastKnownState: "failed",
      exitedAt: new Date().toISOString(),
    },
    lastFailureReason: message,
  }));
};

export const recordStartupFailure = async (paths: CraigPaths, taskId: string, message: string): Promise<TaskRecord> => {
  return mutateTask(paths, taskId, (task): TaskRecord => ({
    ...task,
    status: "draft",
    runnerSession: {
      ...task.runnerSession,
      lastKnownState: "failed",
      exitedAt: new Date().toISOString(),
    },
    lastFailureReason: message,
  }));
};

export const markTaskStarted = async (paths: CraigPaths, taskId: string): Promise<TaskRecord> => {
  return mutateTask(paths, taskId, (task): TaskRecord => {
    const agentTab = task.ptyTabs.find((tab) => tab.kind === "agent");
    if (!agentTab) {
      throw new Error(`Task ${taskId} is missing its agent PTY tab.`);
    }
    return {
      ...task,
      status: "running",
      selectedPtyTabId: agentTab.id,
      runnerSession: {
        ...task.runnerSession,
        startedAt: new Date().toISOString(),
        lastKnownState: "running",
      },
    };
  });
};
