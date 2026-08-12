import { watch, type FSWatcher, type WatchListener } from "node:fs";

import {
  AGENT_READY_AFTER_MS,
  getAgentTabActivity,
  type AgentRuntimeState,
  type PtyActivitySnapshot,
} from "../domain/agent/index.js";
import type { CraigEvent } from "../domain/orchestration/index.js";
import type { CraigPaths } from "../state/craig-paths.js";

/* eslint-disable no-unused-vars */
interface PullRequestEventMonitorOptions {
  reconcileEvents: () => Promise<CraigEvent[]>;
  onEvents: (events: CraigEvent[]) => void | Promise<void>;
  onError: (error: unknown) => void | Promise<void>;
  now?: () => number;
  taskDebounceMs?: number;
  readyAfterMs?: number;
}
/* eslint-enable no-unused-vars */

export class PullRequestEventMonitor {
  private readonly now: () => number;
  private readonly taskDebounceMs: number;
  private readonly readyAfterMs: number;
  private readonly agentStates = new Map<string, AgentRuntimeState>();
  private readonly readinessTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly watchers: FSWatcher[] = [];
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private reconciliation: Promise<void> | null = null;
  private dirty = false;
  private running = false;
  private baselineComplete = false;

  /* eslint-disable no-unused-vars */
  constructor(
    private readonly paths: CraigPaths,
    private readonly options: PullRequestEventMonitorOptions,
  ) {
    this.now = options.now ?? Date.now;
    this.taskDebounceMs = options.taskDebounceMs ?? 50;
    this.readyAfterMs = options.readyAfterMs ?? AGENT_READY_AFTER_MS;
  }
  /* eslint-enable no-unused-vars */

  start(): void {
    if (this.running) return;
    this.running = true;
    this.baselineComplete = false;
    this.watchPath(this.paths.tasksDir, () => this.schedule(this.taskDebounceMs));
    this.watchPath(this.paths.craigDir, (_eventType, filename) => {
      const name = filename === null ? "" : String(filename);
      if (name === "index.json" || name.startsWith(".index.json.")) this.schedule(this.taskDebounceMs);
    });
    this.schedule(0);
  }

  notifyActivity(snapshot: PtyActivitySnapshot): void {
    if (!this.running) return;
    const state = getAgentTabActivity(snapshot.tabId, [snapshot], this.now());
    if (this.agentStates.get(snapshot.tabId) !== state) {
      this.agentStates.set(snapshot.tabId, state);
      this.schedule(0);
    }
    this.scheduleReadiness(snapshot);
  }

  notifyActivityRemoved(tabId: string): void {
    if (!this.running) return;
    this.clearReadinessTimer(tabId);
    if (this.agentStates.delete(tabId)) this.schedule(0);
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    for (const watcher of this.watchers.splice(0)) watcher.close();
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = null;
    for (const timer of this.readinessTimers.values()) clearTimeout(timer);
    this.readinessTimers.clear();
    await this.reconciliation?.catch(() => undefined);
  }

  private scheduleReadiness(snapshot: PtyActivitySnapshot): void {
    this.clearReadinessTimer(snapshot.tabId);
    if (snapshot.sessionState !== "running") return;
    const delay = Math.max(0, snapshot.lastActivityAt + this.readyAfterMs - this.now());
    this.readinessTimers.set(snapshot.tabId, setTimeout(() => {
      this.readinessTimers.delete(snapshot.tabId);
      if (!this.running || this.agentStates.get(snapshot.tabId) !== "working") return;
      this.agentStates.set(snapshot.tabId, "ready");
      this.schedule(0);
    }, delay + 1));
  }

  private watchPath(target: string, listener: WatchListener<string>): void {
    try {
      const watcher = watch(target, { persistent: false }, listener);
      watcher.on("error", (error) => void this.reportError(error));
      this.watchers.push(watcher);
    } catch (error) {
      void this.reportError(error);
    }
  }

  private clearReadinessTimer(tabId: string): void {
    const timer = this.readinessTimers.get(tabId);
    if (timer) clearTimeout(timer);
    this.readinessTimers.delete(tabId);
  }

  private schedule(delayMs: number): void {
    if (!this.running) return;
    if (this.reconciliation) {
      this.dirty = true;
      return;
    }
    if (this.debounceTimer) return;
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.requestReconciliation();
    }, delayMs);
  }

  private requestReconciliation(): void {
    if (!this.running || this.reconciliation) {
      this.dirty = true;
      return;
    }
    this.reconciliation = this.drainReconciliations()
      .catch((error) => this.reportError(error))
      .finally(() => {
        this.reconciliation = null;
        if (this.running && this.dirty) this.requestReconciliation();
      });
  }

  private async drainReconciliations(): Promise<void> {
    do {
      this.dirty = false;
      const events = await this.options.reconcileEvents();
      if (this.baselineComplete && events.length > 0) await this.options.onEvents(events);
      this.baselineComplete = true;
    } while (this.running && this.dirty);
  }

  private async reportError(error: unknown): Promise<void> {
    await this.options.onError(error);
  }
}
