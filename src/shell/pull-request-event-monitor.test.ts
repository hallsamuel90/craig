import { EventEmitter } from "node:events";
import type { WatchListener } from "node:fs";

import { describe, expect, test, vi } from "vitest";

import type { CraigEvent } from "../domain/orchestration/index.js";
import { getCraigPaths } from "../state/craig-paths.js";
import { PullRequestEventMonitor } from "./pull-request-event-monitor.js";

describe("PullRequestEventMonitor", () => {
  test("reconciles on activity transitions and its readiness deadline without periodic scans", async () => {
    vi.useFakeTimers();
    const paths = getCraigPaths("/unused/event-monitor-test");
    const onEvents = vi.fn();
    const reconcileEvents = vi.fn<() => Promise<CraigEvent[]>>()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([event("working")])
      .mockResolvedValueOnce([event("ready")])
      .mockResolvedValue([]);
    const monitor = new PullRequestEventMonitor(paths, {
      reconcileEvents,
      onEvents,
      onError: vi.fn(),
      readyAfterMs: 20,
      watchPath: () => Object.assign(new EventEmitter(), { close() {} }),
    });

    try {
      monitor.start();
      await vi.advanceTimersByTimeAsync(1);
      expect(reconcileEvents).toHaveBeenCalledOnce();
      expect(onEvents).not.toHaveBeenCalled();

      monitor.notifyActivity({
        taskId: "task_1",
        tabId: "task_1:agent",
        sessionState: "running",
        lastActivityAt: Date.now(),
        exitCode: null,
        error: null,
      });
      await vi.advanceTimersByTimeAsync(1);
      expect(onEvents).toHaveBeenCalledWith([event("working")]);
      await vi.advanceTimersByTimeAsync(21);
      expect(onEvents).toHaveBeenCalledWith([event("ready")]);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(reconcileEvents).toHaveBeenCalledTimes(3);
    } finally {
      await monitor.stop();
      vi.useRealTimers();
    }
  });

  test("debounces task and atomic index notifications and closes subscriptions", async () => {
    vi.useFakeTimers();
    const paths = getCraigPaths("/unused/event-monitor-test");
    const listeners = new Map<string, WatchListener<string>>();
    const close = vi.fn();
    const reconcileEvents = vi.fn(async () => []);
    const onError = vi.fn();
    const monitor = new PullRequestEventMonitor(paths, {
      reconcileEvents, onEvents: vi.fn(), onError,
      watchPath: (target, listener) => {
        listeners.set(target, listener);
        return Object.assign(new EventEmitter(), { close });
      },
    });
    try {
      monitor.start();
      await vi.advanceTimersByTimeAsync(1);
      expect(reconcileEvents).toHaveBeenCalledOnce();
      listeners.get(paths.craigDir)!("rename", "unrelated.json");
      await vi.advanceTimersByTimeAsync(100);
      expect(reconcileEvents).toHaveBeenCalledOnce();
      listeners.get(paths.tasksDir)!("rename", "task_1.json");
      listeners.get(paths.tasksDir)!("change", "task_1.json");
      await vi.advanceTimersByTimeAsync(49);
      expect(reconcileEvents).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(1);
      expect(reconcileEvents).toHaveBeenCalledTimes(2);
      for (const filename of ["index.json", ".index.json.atomic-write"]) {
        listeners.get(paths.craigDir)!("rename", filename);
        await vi.advanceTimersByTimeAsync(50);
      }
      expect(reconcileEvents).toHaveBeenCalledTimes(4);
      await monitor.stop();
      expect(close).toHaveBeenCalledTimes(2);
      listeners.get(paths.tasksDir)!("change", "task_1.json");
      await vi.advanceTimersByTimeAsync(60_000);
      expect(reconcileEvents).toHaveBeenCalledTimes(4);
      expect(onError).not.toHaveBeenCalled();
    } finally {
      await monitor.stop();
      vi.useRealTimers();
    }
  });
});

function event(state: string): CraigEvent {
  return {
    schemaVersion: 1,
    id: `agent:${state}`,
    sequence: 1,
    workspaceId: "workspace",
    taskId: "task_1",
    agentTabId: "task_1:agent",
    commandId: null,
    furyRunId: null,
    furyStepId: null,
    type: "agent.state.changed",
    occurredAt: "2026-08-06T12:00:00.000Z",
    actor: { type: "system", component: "heartbeat" },
    data: { state },
  };
}
