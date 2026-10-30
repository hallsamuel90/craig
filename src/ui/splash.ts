import { getTaskAgentTabActivity, type PtyActivitySnapshot } from "./agent-activity.js";
import type { WorkspaceShellModel } from "./shell/data.js";

export interface SplashSummary {
  workspaceCount: number;
  taskCount: number;
  workingAgents: number;
  readyAgents: number;
  attentionAgents: number;
  activityKnown: boolean;
}

export function buildSplashSummary(model: WorkspaceShellModel, snapshots: readonly PtyActivitySnapshot[], now: number, activityKnown: boolean): SplashSummary {
  const tasks = model.tasks.filter((task) => task.status !== "closed" && task.status !== "merged");
  const summary: SplashSummary = {
    workspaceCount: model.workspaces?.filter((workspace) => workspace.status === "active").length ?? model.repos.length,
    taskCount: tasks.length,
    workingAgents: 0,
    readyAgents: 0,
    attentionAgents: 0,
    activityKnown,
  };
  if (!activityKnown) return summary;
  for (const task of tasks) {
    for (const tab of task.ptyTabs) {
      if (tab.kind !== "agent") continue;
      const state = getTaskAgentTabActivity(task, tab.id, snapshots, now);
      if (state === "working") summary.workingAgents++;
      if (state === "ready") summary.readyAgents++;
      if (state === "error") summary.attentionAgents++;
    }
  }
  return summary;
}
