import path from "node:path";

import type { CommandContext } from "./commands/command-router.js";
import { listRegisteredRepos } from "./services/repo-registry.js";
import { listWorkspaces } from "./services/workspace-registry.js";

export async function renderControlView(context: CommandContext, recentEvent: string | null): Promise<string> {
  const [repos, workspaces, archived] = await Promise.all([
    listRegisteredRepos(context.paths),
    listWorkspaces(context.paths, { archived: false }),
    listWorkspaces(context.paths, { archived: true }),
  ]);
  const lines = [
    "CRAIG WORKSPACE",
    `Workspace: ${path.basename(context.paths.workspaceRoot)} | Repos: ${repos.repos.length} | Active workspaces: ${workspaces.workspaces.length}`,
    `Archived: ${archived.workspaces.length}`,
    recentEvent ? `Recent: ${recentEvent}` : "Recent: ready",
  ];

  if (repos.repos.length === 0) {
    lines.push("<no repos>");
  } else {
    lines.push("REPOS");
    lines.push(...repos.repos.map((repo) => `${repo.id}\t${repo.defaultBranch}\t${repo.rootPath}`));
  }

  return lines.join("\n");
}
