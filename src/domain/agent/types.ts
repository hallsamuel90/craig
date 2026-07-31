import type { RunnerType } from "../config/index.js";

export type AgentRuntimeState = "idle" | "working" | "ready" | "error";
export type PtyActivitySessionState = "running" | "exited" | "failed";

export interface PtyActivitySnapshot {
  taskId: string;
  tabId: string;
  sessionState: PtyActivitySessionState;
  lastActivityAt: number;
  exitCode: number | null;
  error: string | null;
}

export interface AgentRuntimeStatus {
  taskId: string;
  tabId: string;
  title: string;
  runner: RunnerType;
  state: AgentRuntimeState;
  sessionState: PtyActivitySessionState | null;
  lastActivityAt: number | null;
  exitCode: number | null;
  error: string | null;
}

export interface TaskAgentRuntimeStatus {
  taskId: string;
  state: AgentRuntimeState;
  agentTabIds: string[];
}

export interface CommandAgentListResult {
  kind: "listAgents";
  agents: AgentRuntimeStatus[];
  tasks: TaskAgentRuntimeStatus[];
  daemonAvailable: boolean;
}

export interface CommandAgentStatusResult {
  kind: "showAgentStatus";
  agents: AgentRuntimeStatus[];
  tasks: TaskAgentRuntimeStatus[];
  daemonAvailable: boolean;
}

export interface CommandTaskWaitResult {
  kind: "waitTask";
  taskId: string;
  tabId: string | null;
  state: AgentRuntimeState;
  matchedStates: AgentRuntimeState[];
  observedAt: string;
}

export interface AgentRuntimeObserver {
  daemonAvailable: boolean;
  getSnapshots(): readonly PtyActivitySnapshot[];
  /* eslint-disable-next-line no-unused-vars */
  subscribe(listener: () => void): () => void;
  close(): void;
}
