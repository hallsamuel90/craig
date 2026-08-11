import type { TaskRecord } from "../task/index.js";
import type {
  AgentRuntimeState,
  AgentRuntimeStatus,
  PtyActivitySnapshot,
  TaskAgentRuntimeStatus,
} from "./types.js";

export const AGENT_READY_AFTER_MS = 5_000;

const ACTIVITY_PRIORITY: Record<AgentRuntimeState, number> = {
  idle: 0,
  ready: 1,
  working: 2,
  error: 3,
};

interface AgentActivityTask {
  ptyTabs: ReadonlyArray<{ id: string; kind: "agent" | "terminal" }>;
  runnerSession?: { lastKnownState: string };
}

export function getAgentTabActivity(
  tabId: string,
  snapshots: readonly PtyActivitySnapshot[],
  now: number,
  fallback: AgentRuntimeState = "idle",
): AgentRuntimeState {
  const snapshot = snapshots.find((entry) => entry.tabId === tabId);
  if (!snapshot) return fallback;
  if (snapshot.sessionState === "failed" || (snapshot.sessionState === "exited" && snapshot.exitCode !== 0)) {
    return "error";
  }
  if (snapshot.sessionState === "exited") return "ready";
  return now - snapshot.lastActivityAt < AGENT_READY_AFTER_MS ? "working" : "ready";
}

export function getTaskAgentTabActivity(
  task: AgentActivityTask,
  tabId: string,
  snapshots: readonly PtyActivitySnapshot[],
  now: number,
): AgentRuntimeState {
  const firstAgentTabId = task.ptyTabs.find((tab) => tab.kind === "agent")?.id;
  const fallback = tabId === firstAgentTabId && task.runnerSession?.lastKnownState === "failed"
    ? "error"
    : "idle";
  return getAgentTabActivity(tabId, snapshots, now, fallback);
}

export function getTaskAgentActivity(
  task: AgentActivityTask,
  snapshots: readonly PtyActivitySnapshot[],
  now: number,
): AgentRuntimeState {
  let result: AgentRuntimeState = "idle";
  for (const tab of task.ptyTabs) {
    if (tab.kind !== "agent") continue;
    const activity = getTaskAgentTabActivity(task, tab.id, snapshots, now);
    if (ACTIVITY_PRIORITY[activity] > ACTIVITY_PRIORITY[result]) result = activity;
  }
  return result;
}

export function hasWorkingAgentActivity(
  tasks: readonly AgentActivityTask[],
  snapshots: readonly PtyActivitySnapshot[],
  now: number,
): boolean {
  return tasks.some((task) =>
    task.ptyTabs.some((tab) =>
      tab.kind === "agent" && getAgentTabActivity(tab.id, snapshots, now) === "working"));
}

export function buildAgentRuntimeStatuses(
  tasks: readonly TaskRecord[],
  snapshots: readonly PtyActivitySnapshot[],
  now: number,
): { agents: AgentRuntimeStatus[]; tasks: TaskAgentRuntimeStatus[] } {
  const agents = tasks.flatMap((task) => task.ptyTabs
    .filter((tab) => tab.kind === "agent")
    .map((tab): AgentRuntimeStatus => {
      const snapshot = snapshots.find((entry) => entry.tabId === tab.id);
      const state = getTaskAgentTabActivity(task, tab.id, snapshots, now);
      return {
        taskId: task.id,
        tabId: tab.id,
        title: tab.title,
        runner: tab.runner ?? task.runner,
        state,
        sessionState: snapshot?.sessionState ?? null,
        lastActivityAt: snapshot?.lastActivityAt ?? null,
        exitCode: snapshot?.exitCode ?? null,
        error: snapshot?.error ?? (state === "error" ? task.lastFailureReason ?? null : null),
      };
    }));
  const taskStatuses = tasks.map((task): TaskAgentRuntimeStatus => ({
    taskId: task.id,
    state: getTaskAgentActivity(task, snapshots, now),
    agentTabIds: agents.filter((agent) => agent.taskId === task.id).map((agent) => agent.tabId),
  }));
  return { agents, tasks: taskStatuses };
}
