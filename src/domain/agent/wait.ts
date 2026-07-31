import { CraigError } from "../error/index.js";
import type { TaskRecord } from "../task/index.js";
import { buildAgentRuntimeStatuses } from "./activity.js";
import type {
  AgentRuntimeObserver,
  AgentRuntimeState,
  CommandTaskWaitResult,
} from "./types.js";

export async function waitForTaskAgentState(
  task: TaskRecord,
  observer: AgentRuntimeObserver,
  options: {
    states: readonly AgentRuntimeState[];
    tabId?: string;
    timeoutMs: number;
    signal?: AbortSignal;
    now?: () => number;
  },
): Promise<CommandTaskWaitResult> {
  const now = options.now ?? Date.now;
  if (options.tabId && !task.ptyTabs.some((tab) => tab.kind === "agent" && tab.id === options.tabId)) {
    throw new CraigError(
      "TASK_CONTEXT_CONFLICT",
      `Agent tab ${options.tabId} does not belong to task ${task.id}.`,
      { details: { taskId: task.id, tabId: options.tabId } },
    );
  }

  let revision = 0;
  let notify: (() => void) | null = null;
  const unsubscribe = observer.subscribe(() => {
    revision += 1;
    notify?.();
  });
  const deadline = now() + options.timeoutMs;

  try {
    while (true) {
      const observedAt = now();
      const statuses = buildAgentRuntimeStatuses([task], observer.getSnapshots(), observedAt);
      const state = options.tabId
        ? statuses.agents.find((agent) => agent.tabId === options.tabId)?.state ?? "idle"
        : statuses.tasks[0]?.state ?? "idle";
      if (options.states.includes(state)) {
        return {
          kind: "waitTask",
          taskId: task.id,
          tabId: options.tabId ?? null,
          state,
          matchedStates: [...options.states],
          observedAt: new Date(observedAt).toISOString(),
        };
      }
      if (options.signal?.aborted) throw cancelled(task.id);
      const remainingMs = deadline - now();
      if (remainingMs <= 0) throw timedOut(task.id, options.states, options.timeoutMs);

      const baseline = revision;
      await new Promise<void>((resolve, reject) => {
        const finish = () => {
          clearTimeout(timeout);
          options.signal?.removeEventListener("abort", onAbort);
          resolve();
        };
        const onAbort = () => {
          clearTimeout(timeout);
          reject(cancelled(task.id));
        };
        const timeout = setTimeout(finish, remainingMs);
        notify = finish;
        options.signal?.addEventListener("abort", onAbort, { once: true });
        if (revision !== baseline) notify();
      });
      notify = null;
    }
  } finally {
    unsubscribe();
  }
}

const timedOut = (taskId: string, states: readonly AgentRuntimeState[], timeoutMs: number) =>
  new CraigError(
    "OPERATION_TIMEOUT",
    `Timed out after ${timeoutMs}ms waiting for task ${taskId} agent state ${states.join(",")}.`,
    { retryable: true, details: { taskId, states, timeoutMs } },
  );

const cancelled = (taskId: string) =>
  new CraigError(
    "OPERATION_CANCELLED",
    `Cancelled while waiting for task ${taskId} agent state.`,
    { retryable: true, details: { taskId, cancelled: true } },
  );
