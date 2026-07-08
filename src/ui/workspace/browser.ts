import { readdir, stat } from "node:fs/promises";
import path from "node:path";

import type { WorkspaceBrowserEntry, WorkspaceBrowserState } from "../state.js";
import type { AppContext } from "../app-context.js";
import { syncShell } from "../shell/sync.js";

export async function loadWorkspaceBrowser(rootPath: string): Promise<WorkspaceBrowserState> {
  const directoryEntries = await readdir(rootPath, { withFileTypes: true });
  const entries: WorkspaceBrowserEntry[] = [];

  for (const entry of directoryEntries) {
    if (!entry.isDirectory()) continue;
    const entryPath = path.join(rootPath, entry.name);
    entries.push({
      name: entry.name,
      path: entryPath,
      kind: (await isGitRepoDirectory(entryPath)) ? "repo" : "directory",
    });
  }

  entries.sort((left, right) => {
    if (left.kind !== right.kind) return left.kind === "repo" ? -1 : 1;
    return left.name.localeCompare(right.name);
  });

  return { cwd: rootPath, entries, selectedIndex: 0, query: null, error: null };
}

export function getWorkspaceBrowserVisibleEntries(browser: WorkspaceBrowserState): WorkspaceBrowserEntry[] {
  if (!browser.query) {
    return browser.entries;
  }

  const q = browser.query.toLowerCase();
  return browser.entries.filter((entry) => entry.name.toLowerCase().includes(q));
}

export async function openUrl(url: string): Promise<void> {
  const { spawn } = await import("node:child_process");
  const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  await new Promise<void>((resolve, reject) => {
    const child = spawn(opener, [url], { stdio: "ignore", detached: true });
    child.unref();
    child.on("error", reject);
    child.on("spawn", resolve);
  });
}

export async function openWorkspaceBrowser(ctx: AppContext, rootPath: string): Promise<void> {
  const browser = await loadWorkspaceBrowser(rootPath);
  if (ctx.state.mode !== "main") {
    return;
  }

  ctx.state = {
    mode: "main",
    shell: syncShell(ctx, {
      ...ctx.state.shell,
      workspaceBrowser: browser,
      activeTab: ctx.state.shell.selectedPtyTabId ?? ctx.state.shell.activeTab,
      actionMessage: null,
    }),
  };
  ctx.render();
}

export async function isGitRepoDirectory(rootPath: string): Promise<boolean> {
  const gitPath = path.join(rootPath, ".git");
  const stats = await stat(gitPath).catch(() => null);
  return stats !== null;
}
