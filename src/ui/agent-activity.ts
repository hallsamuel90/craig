export type AgentActivityState = "idle" | "working" | "ready" | "error";
export type PtyActivitySessionState = "running" | "exited" | "failed";

export interface PtyActivitySnapshot {
  taskId: string;
  tabId: string;
  sessionState: PtyActivitySessionState;
  lastActivityAt: number;
  exitCode: number | null;
  error: string | null;
}

export interface AgentActivityPresentation {
  snapshots: readonly PtyActivitySnapshot[];
  now: number;
  animationFrame: number;
}

export const AGENT_READY_AFTER_MS = 5_000;
export const AGENT_ACTIVITY_ANIMATION_FRAMES = 4;

const ACTIVITY_PRIORITY: Record<AgentActivityState, number> = {
  idle: 0,
  working: 1,
  ready: 2,
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
  fallback: AgentActivityState = "idle",
): AgentActivityState {
  const snapshot = snapshots.find((entry) => entry.tabId === tabId);
  if (!snapshot) {
    return fallback;
  }
  if (snapshot.sessionState === "failed" || (snapshot.sessionState === "exited" && snapshot.exitCode !== 0)) {
    return "error";
  }
  if (snapshot.sessionState === "exited") {
    return "ready";
  }
  return now - snapshot.lastActivityAt < AGENT_READY_AFTER_MS ? "working" : "ready";
}

export function getTaskAgentTabActivity(
  task: AgentActivityTask,
  tabId: string,
  snapshots: readonly PtyActivitySnapshot[],
  now: number,
): AgentActivityState {
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
): AgentActivityState {
  let result: AgentActivityState = "idle";
  for (const tab of task.ptyTabs) {
    if (tab.kind !== "agent") {
      continue;
    }
    const activity = getTaskAgentTabActivity(task, tab.id, snapshots, now);
    if (ACTIVITY_PRIORITY[activity] > ACTIVITY_PRIORITY[result]) {
      result = activity;
    }
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
