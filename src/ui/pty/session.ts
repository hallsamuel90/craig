import path from "node:path";

import type { TaskPtyTabRecord } from "../../domain/task/index.js";
import type { WorkspaceShellModel } from "../shell/data.js";
import { CENTER_TERMINAL_GUTTER } from "../render.js";
import { SHELL_LAYOUT, type Viewport } from "../layout.js";
import type { PtySize } from "./runtime.js";

export function resolvePtySessionSpec(model: WorkspaceShellModel, tabId: string, workspaceRoot: string) {
  const task = model.tasks.find((entry) => entry.ptyTabs.some((tab) => tab.id === tabId)) ?? null;
  const tab = task?.ptyTabs.find((entry) => entry.id === tabId) ?? null;
  const cwd = task?.worktreePath ?? workspaceRoot;
  const command = tab?.kind === "agent" ? resolveAgentCommand(tab) : [];

  if (task?.type === "project") {
    return {
      cwd,
      command,
      env: { GIT_CEILING_DIRECTORIES: appendGitCeilingDirectory(process.env.GIT_CEILING_DIRECTORIES, cwd) },
    };
  }

  return { cwd, command };
}

function appendGitCeilingDirectory(current: string | undefined, directory: string): string {
  const entries = (current ?? "").split(path.delimiter).filter((entry) => entry.length > 0);
  return entries.includes(directory) ? entries.join(path.delimiter) : [...entries, directory].join(path.delimiter);
}

function resolveAgentCommand(tab: TaskPtyTabRecord): string[] {
  return tab.command.length > 0 ? tab.command : ["codex"];
}

export function getRequiredPtyTabId(task: { id: string; ptyTabs: TaskPtyTabRecord[] }, kind: TaskPtyTabRecord["kind"]): string {
  const tab = task.ptyTabs.find((entry) => entry.kind === kind);
  if (!tab) {
    throw new Error(`Task ${task.id} is missing its ${kind} PTY tab.`);
  }

  return tab.id;
}

export function getPtySize(viewport: Viewport): PtySize {
  // The center PTY surface reserves:
  // 1. tab strip
  // 2. active-tab underline
  // 3. task header
  // 4. spacer before the PTY surface
  // 5. full-width footer row
  return {
    columns: Math.max(
      20,
      viewport.width -
        SHELL_LAYOUT.leftWidth -
        SHELL_LAYOUT.rightWidth -
        SHELL_LAYOUT.dividerWidth -
        CENTER_TERMINAL_GUTTER * 2,
    ),
    rows: Math.max(5, viewport.height - SHELL_LAYOUT.topRailHeight - 5),
  };
}
