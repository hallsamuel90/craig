import { describe, expect, test } from "vitest";

import {
  AGENT_READY_AFTER_MS,
  getAgentTabActivity,
  getTaskAgentActivity,
  getTaskAgentTabActivity,
  hasWorkingAgentActivity,
  type PtyActivitySnapshot,
} from "./agent-activity.js";

const NOW = 10_000;

describe("agent activity", () => {
  test("derives working, ready, idle, and error states from runtime snapshots", () => {
    expect(getAgentTabActivity("agent", [snapshot({ lastActivityAt: NOW - 1 })], NOW)).toBe("working");
    expect(getAgentTabActivity("agent", [snapshot({ lastActivityAt: NOW - AGENT_READY_AFTER_MS })], NOW)).toBe("ready");
    expect(getAgentTabActivity("missing", [], NOW)).toBe("idle");
    expect(getAgentTabActivity("agent", [snapshot({ sessionState: "exited", exitCode: 0 })], NOW)).toBe("ready");
    expect(getAgentTabActivity("agent", [snapshot({ sessionState: "exited", exitCode: 7 })], NOW)).toBe("error");
    expect(getAgentTabActivity("agent", [snapshot({ sessionState: "failed", error: "spawn failed" })], NOW)).toBe("error");
  });

  test("keeps a task working while any agent tab is active and ignores terminal tabs", () => {
    const task = {
      ptyTabs: [
        { id: "task:agent", kind: "agent" as const },
        { id: "task:agent-2", kind: "agent" as const },
        { id: "task:terminal", kind: "terminal" as const },
      ],
    };

    expect(getTaskAgentActivity(task, [
      snapshot({ tabId: "task:agent", lastActivityAt: NOW - 1 }),
      snapshot({ tabId: "task:agent-2", lastActivityAt: NOW - AGENT_READY_AFTER_MS }),
      snapshot({ tabId: "task:terminal", sessionState: "failed" }),
    ], NOW)).toBe("working");

    expect(getTaskAgentActivity(task, [
      snapshot({ tabId: "task:agent", lastActivityAt: NOW - 1 }),
      snapshot({ tabId: "task:agent-2", sessionState: "failed" }),
    ], NOW)).toBe("error");
  });

  test("reports whether any task has a working agent tab", () => {
    const tasks = [{ ptyTabs: [{ id: "task:agent", kind: "agent" as const }] }];
    expect(hasWorkingAgentActivity(tasks, [snapshot({ tabId: "task:agent", lastActivityAt: NOW })], NOW)).toBe(true);
    expect(hasWorkingAgentActivity(tasks, [snapshot({ tabId: "task:agent", lastActivityAt: 0 })], NOW)).toBe(false);
  });

  test("uses a durable runner failure when the primary agent has no PTY snapshot", () => {
    const task = {
      runnerSession: { lastKnownState: "failed" },
      ptyTabs: [
        { id: "task:agent", kind: "agent" as const },
        { id: "task:agent-2", kind: "agent" as const },
      ],
    };

    expect(getTaskAgentTabActivity(task, "task:agent", [], NOW)).toBe("error");
    expect(getTaskAgentTabActivity(task, "task:agent-2", [], NOW)).toBe("idle");
    expect(getTaskAgentActivity(task, [], NOW)).toBe("error");
  });
});

function snapshot(overrides: Partial<PtyActivitySnapshot> = {}): PtyActivitySnapshot {
  return {
    taskId: "task",
    tabId: "agent",
    sessionState: "running",
    lastActivityAt: NOW,
    exitCode: null,
    error: null,
    ...overrides,
  };
}
