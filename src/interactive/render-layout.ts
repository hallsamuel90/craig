import path from "node:path";
import pc from "picocolors";

import type { OverlayMode, RepoRecord, WorkspaceRecord } from "../types/workspace.js";

interface RenderWorkspaceOverlayInput {
  workspaceRoot: string;
  repos: RepoRecord[];
  workspaces: WorkspaceRecord[];
  archivedWorkspaces: WorkspaceRecord[];
  overlayMode: OverlayMode;
  selectedMenuIndex: number;
  messageLines: string[];
  terminalSize: {
    columns: number;
    rows: number;
  };
}

const MENU_ITEMS = ["Start", "Archives", "Options", "Exit"] as const;

export function renderWorkspaceOverlay(input: RenderWorkspaceOverlayInput): string {
  const width = input.terminalSize.columns;
  const lines: string[] = [];
  lines.push(truncate(`CRAIG | ${path.basename(input.workspaceRoot)} | overlay`, width));
  lines.push(divider(width));
  lines.push(truncate(`Repos: ${input.repos.length} | Active workspaces: ${input.workspaces.length} | Archived: ${input.archivedWorkspaces.length}`, width));
  lines.push("");

  for (const [index, item] of MENU_ITEMS.entries()) {
    const marker = input.selectedMenuIndex === index ? pc.green(">") : " ";
    lines.push(truncate(`${marker} ${item}`, width));
  }

  lines.push("");
  lines.push(truncate(input.overlayMode === "archives" ? "Archived workspaces" : "Active repos and workspaces", width));
  lines.push(divider(width));

  const records =
    input.overlayMode === "archives"
      ? input.archivedWorkspaces.map((workspace) => `${workspace.id} | ${workspace.branch}`)
      : [
          ...input.repos.map((repo) => `repo ${repo.id} | ${repo.defaultBranch} | ${repo.rootPath}`),
          ...input.workspaces.map((workspace) => `workspace ${workspace.id} | ${workspace.branch}`),
        ];

  if (records.length === 0) {
    lines.push(input.overlayMode === "archives" ? "<no archived workspaces>" : "<no repos registered>");
  } else {
    lines.push(...records.slice(0, Math.max(1, input.terminalSize.rows - 12)).map((line) => truncate(line, width)));
  }

  if (input.messageLines.length > 0) {
    lines.push("");
    lines.push(divider(width));
    lines.push(...input.messageLines.map((line) => truncate(line, width)));
  }

  return lines.slice(0, input.terminalSize.rows).map((line) => line.padEnd(width, " ")).join("\n");
}

function divider(width: number): string {
  return "-".repeat(Math.max(8, width));
}

function truncate(value: string, width: number): string {
  if (value.length <= width) {
    return value;
  }

  if (width <= 1) {
    return value.slice(0, width);
  }

  return `${value.slice(0, width - 1)}…`;
}
