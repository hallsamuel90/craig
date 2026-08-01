import { configService } from "../domain/config/index.js";
import { CraigError } from "../domain/error/index.js";
import type { AgentRuntimeState, CommandTaskWaitResult } from "../domain/agent/index.js";
import {
  listEvents,
  type CraigEvent,
  type CraigEventFilter,
  type CommandEventListResult,
  type CommandEventWatchResult,
} from "../domain/orchestration/index.js";
import type { CraigPaths } from "../state/craig-paths.js";
import { reconcileEvents } from "./event-reconciliation.js";
import { agentStatusService } from "./agent-status.js";
import { buildAgentRuntimeStatuses } from "../domain/agent/index.js";
import { taskService } from "../domain/task/index.js";

export async function listWorkspaceEvents(
  paths: CraigPaths,
  filter: CraigEventFilter,
): Promise<CommandEventListResult> {
  await assertEnabled(paths);
  await reconcileEvents(paths);
  return listEvents(paths, filter);
}

export async function watchWorkspaceEvents(
  paths: CraigPaths,
  filter: CraigEventFilter,
  options: {
    signal?: AbortSignal;
    /* eslint-disable-next-line no-unused-vars */
    onEvent(event: CraigEvent): void;
    pollIntervalMs?: number;
  },
): Promise<CommandEventWatchResult> {
  await assertEnabled(paths);
  const observer = await agentStatusService.openObserver(paths);
  try {
    let cursor = filter.after;
    let eventCount = 0;
    let lastSequence = 0;
    while (!options.signal?.aborted) {
      await reconcileEvents(paths, { agentObserver: observer });
      const result = await listEvents(paths, { ...filter, ...(cursor ? { after: cursor } : {}) });
      for (const event of result.events) {
        options.onEvent(event);
        eventCount += 1;
      }
      cursor = result.cursor.after ?? cursor;
      lastSequence = result.cursor.sequence;
      if (options.signal?.aborted) break;
      await waitForNextPoll(options.pollIntervalMs ?? 250, options.signal);
    }
    return { kind: "watchEvents", eventCount, lastSequence, cancelled: options.signal?.aborted ?? false };
  } finally {
    observer.close();
  }
}

export async function waitForTaskStateEvent(
  paths: CraigPaths,
  taskId: string,
  options: {
    states: readonly AgentRuntimeState[];
    tabId?: string;
    timeoutMs: number;
    signal?: AbortSignal;
  },
): Promise<CommandTaskWaitResult> {
  await assertEnabled(paths);
  const task = await taskService.getTask(paths, taskId);
  if (options.tabId && !task.ptyTabs.some((tab) => tab.kind === "agent" && tab.id === options.tabId)) {
    throw new CraigError("TASK_CONTEXT_CONFLICT", `Agent tab ${options.tabId} does not belong to task ${taskId}.`, {
      details: { taskId, tabId: options.tabId },
    });
  }
  const observer = await agentStatusService.openObserver(paths);
  try {
    await reconcileEvents(paths, { agentObserver: observer });
    const baseline = await listEvents(paths, { taskId, typeGlob: "agent.state.changed" });
    let cursor = baseline.cursor.after ?? undefined;
    const deadline = Date.now() + options.timeoutMs;

    while (true) {
      const observedAt = Date.now();
      const statuses = buildAgentRuntimeStatuses([task], observer.getSnapshots(), observedAt);
      const state = options.tabId
        ? statuses.agents.find((agent) => agent.tabId === options.tabId)?.state ?? "idle"
        : statuses.tasks[0]?.state ?? "idle";
      if (options.states.includes(state)) {
        return {
          kind: "waitTask",
          taskId,
          tabId: options.tabId ?? null,
          state,
          matchedStates: [...options.states],
          observedAt: new Date(observedAt).toISOString(),
        };
      }
      if (options.signal?.aborted) throw cancelled(taskId);
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) throw timedOut(taskId, options.states, options.timeoutMs);

      await reconcileEvents(paths, { agentObserver: observer });
      const events = await listEvents(paths, {
        taskId,
        typeGlob: "agent.state.changed",
        ...(cursor ? { after: cursor } : {}),
      });
      cursor = events.cursor.after ?? cursor;
      await waitForNextPoll(Math.min(250, remainingMs), options.signal);
    }
  } finally {
    observer.close();
  }
}

async function assertEnabled(paths: CraigPaths): Promise<void> {
  const config = await configService.load(paths);
  if (!configService.previews.isEnabled(config, "agentOrchestration")) {
    throw new CraigError(
      "CLI_USAGE",
      "Event orchestration is a feature preview. Enable agentOrchestration before using events commands.",
      { details: { preview: "agentOrchestration" } },
    );
  }
}

function waitForNextPoll(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    signal?.addEventListener("abort", finish, { once: true });
  });
}

const timedOut = (taskId: string, states: readonly AgentRuntimeState[], timeoutMs: number) => new CraigError(
  "OPERATION_TIMEOUT",
  `Timed out after ${timeoutMs}ms waiting for task ${taskId} agent state ${states.join(",")}.`,
  { retryable: true, details: { taskId, states, timeoutMs } },
);

const cancelled = (taskId: string) => new CraigError(
  "OPERATION_CANCELLED",
  `Cancelled while waiting for task ${taskId} agent state.`,
  { retryable: true, details: { taskId, cancelled: true } },
);

export const eventService = {
  list: listWorkspaceEvents,
  watch: watchWorkspaceEvents,
  waitForTaskState: waitForTaskStateEvent,
  reconcile: reconcileEvents,
};
