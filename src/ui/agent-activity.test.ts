import { describe, expect, test } from "vitest";

import {
  acknowledgeAgentActivity,
  hasUnreadAgentActivity,
  AGENT_READY_AFTER_MS,
  getAgentTabActivity,
  getTaskAgentActivity,
  getTaskAgentTabActivity,
  hasWorkingAgentActivity,
  type PtyActivitySnapshot,
} from "./agent-activity.js";

import { createInitialShellState, toPersistedUiState } from "./state.js";

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

describe("agent response read state", () => {
  const task = {
    id: "task",
    ptyTabs: [{ id: "task:agent", kind: "agent" as const, title: "Codex", command: ["codex"], createdAt: "", updatedAt: "" }],
  };
  const tabId = task.ptyTabs.find((tab) => tab.kind === "agent")!.id;
  const snapshots = [snapshot({ tabId, lastActivityAt: 1_000 })];
  const shell = {
    ...createInitialShellState(null),
    selectedTaskId: task.id,
    activeTab: tabId,
    focusedRegion: "center" as const,
    terminal: { status: "running" as const, rows: [{ segments: [{ text: "Agent response" }] }], error: null },
  };

  test("clears unread only when viewing the latest completed agent output", () => {
    expect(hasUnreadAgentActivity([tabId], snapshots, NOW, {})).toBe(true);
    for (const hidden of [
      { ...shell, focusedRegion: "tasks" as const },
      { ...shell, activeTab: "inspection" },
      { ...shell, terminal: { ...shell.terminal, rows: [] } },
      { ...shell, terminal: { ...shell.terminal, scrolledBack: true } },
      { ...shell, selectedTaskId: "other" },
    ]) expect(acknowledgeAgentActivity(hidden, [task], snapshots, NOW)).toBe(hidden);
    const read = acknowledgeAgentActivity(shell, [task], snapshots, NOW);
    expect(hasUnreadAgentActivity([tabId], snapshots, NOW, read.readAgentActivityAt)).toBe(false);
    expect(acknowledgeAgentActivity(read, [task], snapshots, NOW)).toBe(read);
    const restored = createInitialShellState(toPersistedUiState(null, read));
    expect(hasUnreadAgentActivity([tabId], snapshots, NOW, restored.readAgentActivityAt)).toBe(false);
    expect(hasUnreadAgentActivity([tabId], [snapshot({ tabId, lastActivityAt: 2_000 })], NOW, restored.readAgentActivityAt)).toBe(true);
  });

  test("keeps other agent tabs unread and ignores terminal tabs, working output, and failures", () => {
    const other = snapshot({ tabId: "other", lastActivityAt: 1_000 });
    const read = acknowledgeAgentActivity(shell, [task], [...snapshots, other], NOW);
    expect(hasUnreadAgentActivity([tabId, "other"], [...snapshots, other], NOW, read.readAgentActivityAt)).toBe(true);
    expect(hasUnreadAgentActivity([tabId], [other], NOW, {})).toBe(false);
    for (const pending of [snapshot({ tabId }), snapshot({ tabId, sessionState: "failed" })]) {
      expect(acknowledgeAgentActivity(shell, [task], [pending], NOW)).toBe(shell);
      expect(hasUnreadAgentActivity([tabId], [pending], NOW, {})).toBe(false);
    }
  });
});
