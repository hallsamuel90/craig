import { getAgentTabActivity } from "../domain/agent/index.js";
import type { TaskRecord } from "../domain/task/index.js";
import type { ControlShellState } from "./state.js";
import type { AgentRuntimeState, PtyActivitySnapshot } from "../domain/agent/index.js";

export type { PtyActivitySnapshot } from "../domain/agent/index.js";
export type AgentActivityState = AgentRuntimeState;
export {
  AGENT_READY_AFTER_MS,
  getAgentTabActivity,
  getTaskAgentTabActivity,
  getTaskAgentActivity,
  hasWorkingAgentActivity,
} from "../domain/agent/index.js";

export interface AgentActivityPresentation {
  snapshots: readonly PtyActivitySnapshot[];
  now: number;
  animationFrame: number;
}

export const AGENT_ACTIVITY_ANIMATION_INTERVAL_MS = 150;
export const AGENT_ACTIVITY_ANIMATION_FRAMES = 6;

/** Acknowledges only the completed output in an agent pane the user is reading. */
export function acknowledgeAgentActivity(
  shell: ControlShellState,
  tasks: readonly Pick<TaskRecord, "id" | "ptyTabs">[],
  snapshots: readonly PtyActivitySnapshot[],
  now: number,
): ControlShellState {
  if ((shell.inputMode !== "terminal" && shell.focusedRegion !== "center")
    || shell.terminal.scrolledBack || shell.terminal.rows.length === 0) return shell;
  const task = tasks.find((entry) => entry.id === shell.selectedTaskId);
  const tab = task?.ptyTabs.find((entry) => entry.id === shell.activeTab
    || (shell.activeTab === "agent" && entry.kind === "agent"));
  if (tab?.kind !== "agent") return shell;
  const snapshot = snapshots.find((entry) => entry.tabId === tab.id);
  if (!snapshot || getAgentTabActivity(tab.id, snapshots, now) !== "ready"
    || shell.readAgentActivityAt[tab.id] === snapshot.lastActivityAt) return shell;
  return {
    ...shell,
    readAgentActivityAt: { ...shell.readAgentActivityAt, [tab.id]: snapshot.lastActivityAt },
  };
}

export function hasUnreadAgentActivity(
  tabIds: readonly string[],
  snapshots: readonly PtyActivitySnapshot[],
  now: number,
  readAt: Readonly<Record<string, number>>,
): boolean {
  return snapshots.some((snapshot) => tabIds.includes(snapshot.tabId)
    && getAgentTabActivity(snapshot.tabId, snapshots, now) === "ready"
    && snapshot.lastActivityAt > (readAt[snapshot.tabId] ?? -1));
}
