import path from "node:path";

import type { CommandContext } from "./commands/command-router.js";
import { listTasks } from "./services/list-tasks.js";

export async function renderControlView(context: CommandContext, recentEvent: string | null): Promise<string> {
  const listing = await listTasks(context.paths);
  const lines = [
    "CRAIG CONTROL",
    `Workspace: ${path.basename(context.paths.repoRoot)} | Tasks: ${listing.tasks.length}`,
    recentEvent ? `Recent: ${recentEvent}` : "Recent: ready",
    "ID\tSTATUS\tRUNNER\tCHECKS\tPR\tPAGE\tTITLE",
  ];

  for (const task of listing.tasks) {
    const pr = task.pullRequest.number ? `#${task.pullRequest.number}:${task.pullRequest.status ?? "unknown"}` : "-";
    lines.push(
      [
        task.id,
        task.status,
        task.runnerSession.lastKnownState,
        task.checks.status,
        pr,
        task.tmuxPage ?? "-",
        task.title,
      ].join("\t"),
    );
  }

  if (listing.tasks.length === 0) {
    lines.push("<no tasks>");
  }

  return lines.join("\n");
}
