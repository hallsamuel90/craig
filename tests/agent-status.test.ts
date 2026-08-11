import { describe, expect, test } from "vitest";

import {
  buildAgentRuntimeStatuses,
  waitForTaskAgentState,
  type AgentRuntimeObserver,
  type PtyActivitySnapshot,
} from "../src/domain/agent/index.js";
import type { TaskRecord } from "../src/domain/task/index.js";
import { buildTaskRecord } from "./test-helpers.js";

const NOW = 10_000;

describe("agent status domain", () => {
  test("uses the same per-tab states and active-work roll-up as the sidebar", () => {
    const task = buildTaskRecord("/tmp/craig-agent-status", {
      id: "task_1",
      ptyTabs: [
        tab("task_1:agent", "agent"),
        tab("task_1:agent-2", "agent"),
        tab("task_1:terminal", "terminal"),
      ],
    });
    const statuses = buildAgentRuntimeStatuses([task], [
      snapshot({ tabId: "task_1:agent", lastActivityAt: NOW }),
      snapshot({ tabId: "task_1:agent-2", sessionState: "exited", exitCode: 0 }),
      snapshot({ tabId: "task_1:terminal", sessionState: "failed" }),
    ], NOW);

    expect(statuses.agents.map((agent) => [agent.tabId, agent.state])).toEqual([
      ["task_1:agent", "working"],
      ["task_1:agent-2", "ready"],
    ]);
    expect(statuses.tasks).toEqual([{
      taskId: "task_1",
      state: "working",
      agentTabIds: ["task_1:agent", "task_1:agent-2"],
    }]);
  });

  test("does not attach the primary runner failure to a secondary idle agent", () => {
    const task = buildTaskRecord("/tmp/craig-agent-failure", {
      id: "task_1",
      lastFailureReason: "primary agent failed to start",
      runnerSession: {
        command: [],
        pid: null,
        startedAt: null,
        lastKnownState: "failed",
        exitCode: null,
        exitedAt: null,
      },
      ptyTabs: [tab("task_1:agent", "agent"), tab("task_1:agent-2", "agent")],
    });

    const statuses = buildAgentRuntimeStatuses([task], [], NOW);

    expect(statuses.agents).toEqual([
      expect.objectContaining({ tabId: "task_1:agent", state: "error", error: "primary agent failed to start" }),
      expect.objectContaining({ tabId: "task_1:agent-2", state: "idle", error: null }),
    ]);
  });

  test("subscribes before its initial read so a transition cannot be missed", async () => {
    const task = buildTaskRecord("/tmp/craig-agent-wait", { id: "task_1" });
    const tabId = task.ptyTabs.find((tab) => tab.kind === "agent")!.id;
    const observer = new FakeObserver([snapshot({ tabId, lastActivityAt: NOW })]);
    observer.onSubscribe = () => observer.emit([snapshot({ tabId, sessionState: "exited", exitCode: 0 })]);

    const result = await waitForTaskAgentState(task, observer, {
      states: ["ready"],
      tabId,
      timeoutMs: 100,
      now: () => NOW,
    });

    expect(result).toMatchObject({ taskId: task.id, tabId, state: "ready" });
  });

  test("reports daemon loss as error for a previously running agent", async () => {
    const task = buildTaskRecord("/tmp/craig-agent-loss", { id: "task_1" });
    const tabId = task.ptyTabs.find((tab) => tab.kind === "agent")!.id;
    const observer = new FakeObserver([snapshot({ tabId, lastActivityAt: NOW })]);
    const waiting = waitForTaskAgentState(task, observer, {
      states: ["error"],
      tabId,
      timeoutMs: 100,
    });

    observer.emit([snapshot({
      tabId,
      sessionState: "failed",
      error: "Craig PTY daemon connection closed.",
    })]);

    await expect(waiting).resolves.toMatchObject({ state: "error" });
  });

  test("times out, supports cancellation, and rejects a tab from another task", async () => {
    const task = buildTaskRecord("/tmp/craig-agent-timeout", { id: "task_1" });
    const observer = new FakeObserver([]);
    await expect(waitForTaskAgentState(task, observer, {
      states: ["ready"],
      timeoutMs: 1,
    })).rejects.toMatchObject({ code: "OPERATION_TIMEOUT", exitCode: 6 });

    const controller = new AbortController();
    controller.abort();
    await expect(waitForTaskAgentState(task, observer, {
      states: ["ready"],
      timeoutMs: 100,
      signal: controller.signal,
    })).rejects.toMatchObject({ code: "OPERATION_CANCELLED", exitCode: 6, details: { cancelled: true } });

    await expect(waitForTaskAgentState(task, observer, {
      states: ["idle"],
      tabId: "other:agent",
      timeoutMs: 100,
    })).rejects.toMatchObject({ code: "TASK_CONTEXT_CONFLICT" });
  });
});

class FakeObserver implements AgentRuntimeObserver {
  daemonAvailable = true;
  onSubscribe: (() => void) | null = null;
  private listeners = new Set<() => void>();

  /* eslint-disable-next-line no-unused-vars */
  constructor(private snapshots: PtyActivitySnapshot[]) {}

  getSnapshots(): readonly PtyActivitySnapshot[] {
    return this.snapshots;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    this.onSubscribe?.();
    return () => this.listeners.delete(listener);
  }

  close(): void {}

  emit(snapshots: PtyActivitySnapshot[]): void {
    this.snapshots = snapshots;
    for (const listener of this.listeners) listener();
  }
}

function snapshot(overrides: Partial<PtyActivitySnapshot> = {}): PtyActivitySnapshot {
  return {
    taskId: "task_1",
    tabId: "task_1:agent",
    sessionState: "running",
    lastActivityAt: NOW,
    exitCode: null,
    error: null,
    ...overrides,
  };
}

function tab(id: string, kind: "agent" | "terminal"): TaskRecord["ptyTabs"][number] {
  return {
    id,
    kind,
    ...(kind === "agent" ? { runner: "codex" as const } : {}),
    title: id,
    command: [],
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  };
}
