import {
  buildAgentRuntimeStatuses,
  waitForTaskAgentState,
  type AgentRuntimeObserver,
  type AgentRuntimeState,
  type PtyActivitySnapshot,
  type CommandAgentListResult,
  type CommandAgentStatusResult,
  type CommandTaskWaitResult,
} from "../domain/agent/index.js";
import { CraigError } from "../domain/error/index.js";
import { taskService, type TaskRecord } from "../domain/task/index.js";
import type { CraigPaths } from "../state/craig-paths.js";
import { tryConnectPtyDaemonActivity, type PtyDaemonActivityClient } from "./pty-daemon-activity.js";

interface AgentStatusDependencies {
  /* eslint-disable no-unused-vars */
  openObserver(paths: CraigPaths): Promise<AgentRuntimeObserver>;
  listTasks(paths: CraigPaths): Promise<{ tasks: TaskRecord[] }>;
  getTask(paths: CraigPaths, taskId: string): Promise<TaskRecord>;
  /* eslint-enable no-unused-vars */
  now(): number;
}

const defaultDependencies: AgentStatusDependencies = {
  openObserver: openDaemonObserver,
  listTasks: (paths) => taskService.listTasks(paths),
  getTask: (paths, taskId) => taskService.getTask(paths, taskId),
  now: Date.now,
};

export async function listAgents(
  paths: CraigPaths,
  taskId?: string,
  deps: AgentStatusDependencies = defaultDependencies,
): Promise<CommandAgentListResult> {
  const tasks = await resolveTasks(paths, taskId, deps);
  const observer = await deps.openObserver(paths);
  try {
    return {
      kind: "listAgents",
      ...buildAgentRuntimeStatuses(tasks, observer.getSnapshots(), deps.now()),
      daemonAvailable: observer.daemonAvailable,
    };
  } finally {
    observer.close();
  }
}

export async function showAgentStatus(
  paths: CraigPaths,
  options: { taskId?: string; tabId?: string },
  deps: AgentStatusDependencies = defaultDependencies,
): Promise<CommandAgentStatusResult> {
  const tasks = await resolveTasks(paths, options.taskId, deps);
  const observer = await deps.openObserver(paths);
  try {
    const statuses = buildAgentRuntimeStatuses(tasks, observer.getSnapshots(), deps.now());
    const agents = options.tabId
      ? statuses.agents.filter((agent) => agent.tabId === options.tabId)
      : statuses.agents;
    if (options.tabId && agents.length === 0) {
      throw new CraigError(
        "TASK_CONTEXT_NOT_FOUND",
        `Agent tab ${options.tabId} was not found${options.taskId ? ` in task ${options.taskId}` : ""}.`,
        { details: { taskId: options.taskId ?? null, tabId: options.tabId } },
      );
    }
    const matchedTaskIds = new Set(agents.map((agent) => agent.taskId));
    return {
      kind: "showAgentStatus",
      agents,
      tasks: options.tabId
        ? statuses.tasks.filter((task) => matchedTaskIds.has(task.taskId))
        : statuses.tasks,
      daemonAvailable: observer.daemonAvailable,
    };
  } finally {
    observer.close();
  }
}

export async function waitForTask(
  paths: CraigPaths,
  taskId: string,
  options: {
    states: readonly AgentRuntimeState[];
    tabId?: string;
    timeoutMs: number;
    signal?: AbortSignal;
  },
  deps: AgentStatusDependencies = defaultDependencies,
): Promise<CommandTaskWaitResult> {
  const task = await deps.getTask(paths, taskId);
  const observer = await deps.openObserver(paths);
  try {
    return await waitForTaskAgentState(task, observer, { ...options, now: deps.now });
  } finally {
    observer.close();
  }
}

async function resolveTasks(
  paths: CraigPaths,
  taskId: string | undefined,
  deps: AgentStatusDependencies,
): Promise<TaskRecord[]> {
  return taskId ? [await deps.getTask(paths, taskId)] : (await deps.listTasks(paths)).tasks;
}

async function openDaemonObserver(paths: CraigPaths): Promise<AgentRuntimeObserver> {
  return DaemonActivityObserver.open(paths);
}

export async function openAgentRuntimeObserver(paths: CraigPaths): Promise<AgentRuntimeObserver> {
  return openDaemonObserver(paths);
}

class DaemonActivityObserver implements AgentRuntimeObserver {
  private readonly listeners = new Set<() => void>();
  private readonly snapshots = new Map<string, PtyActivitySnapshot>();
  private client: PtyDaemonActivityClient | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelayMs = 250;
  private closed = false;
  private readonly paths: CraigPaths;

  private constructor(paths: CraigPaths) {
    this.paths = paths;
  }

  static async open(paths: CraigPaths): Promise<DaemonActivityObserver> {
    const observer = new DaemonActivityObserver(paths);
    await observer.connect();
    return observer;
  }

  get daemonAvailable(): boolean {
    return this.client !== null;
  }

  getSnapshots() {
    return [...this.snapshots.values()];
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close(): void {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.client?.close();
    this.client = null;
  }

  private async connect(): Promise<void> {
    if (this.closed) return;
    const client = await tryConnectPtyDaemonActivity({
      paths: this.paths,
      onActivity: (snapshot) => {
        this.snapshots.set(snapshot.tabId, snapshot);
        this.notify();
      },
      onActivityRemoved: (tabId) => {
        this.snapshots.delete(tabId);
        this.notify();
      },
      onDaemonClose: () => {
        this.client = null;
        this.notify();
        this.scheduleReconnect();
      },
    });
    if (this.closed) {
      client?.close();
      return;
    }
    this.client = client;
    if (client) {
      this.reconnectDelayMs = 250;
      this.snapshots.clear();
      for (const snapshot of client.getSnapshots()) {
        this.snapshots.set(snapshot.tabId, snapshot);
      }
      this.notify();
    } else {
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) return;
    const delayMs = this.reconnectDelayMs;
    this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, 1_000);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delayMs);
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}

export const agentStatusService = {
  listAgents,
  showAgentStatus,
  waitForTask,
  openObserver: openAgentRuntimeObserver,
};
