import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, test, vi } from "vitest";

import type { CraigEvent } from "../domain/orchestration/index.js";
import { getCraigPaths } from "../state/craig-paths.js";
import { PullRequestEventMonitor } from "./pull-request-event-monitor.js";

describe("PullRequestEventMonitor", () => {
  test("reconciles on activity transitions and its readiness deadline without periodic scans", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "craig-pr-event-monitor-"));
    const paths = getCraigPaths(root);
    await mkdir(paths.tasksDir, { recursive: true });
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
    });

    try {
      monitor.start();
      await vi.waitFor(() => expect(reconcileEvents).toHaveBeenCalledOnce());
      expect(onEvents).not.toHaveBeenCalled();

      monitor.notifyActivity({
        taskId: "task_1",
        tabId: "task_1:agent",
        sessionState: "running",
        lastActivityAt: Date.now(),
        exitCode: null,
        error: null,
      });
      await vi.waitFor(() => expect(onEvents).toHaveBeenCalledWith([event("working")]));
      await vi.waitFor(() => expect(onEvents).toHaveBeenCalledWith([event("ready")]));
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(reconcileEvents).toHaveBeenCalledTimes(3);
    } finally {
      await monitor.stop();
      await rm(root, { recursive: true, force: true });
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
