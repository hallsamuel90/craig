import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";

import {
  getDefaultUiRuntime,
  readSessionRuntime,
  writeSessionRuntime,
  type CraigSessionRuntime,
} from "../state/runtime-store.js";
import { runCommand, runCommandAllowingFailure } from "../utils/exec.js";
import { shellEscape } from "../utils/shell-escape.js";

const SESSION_PREFIX = "craig";
const CONTROL_PANE_HEIGHT = 8;

export interface ProvisionedPane {
  paneId: string;
  persistedTarget: string;
  windowTarget: string;
  pageNumber: number;
  layoutSlot: number | null;
}

export interface CraigWorkspace {
  sessionName: string;
  controlPaneTarget: string;
  primaryWindowTarget: string;
}

interface ManagedPage {
  pageNumber: number;
  windowTarget: string;
  isPrimary: boolean;
}

export async function ensureCraigWorkspace(repoRoot: string, sessionFileContext?: { sessionFile: string }): Promise<CraigWorkspace> {
  const sessionName = getSessionNameForRepo(repoRoot);
  const existing = sessionFileContext ? null : null;
  void existing;
  const sessionState = await runCommandAllowingFailure("tmux", ["has-session", "-t", sessionName], {
    cwd: repoRoot,
  });

  if (sessionState.exitCode !== 0) {
    const sizeArgs = getInitialSessionSizeArgs();
    const result = await runCommand(
      "tmux",
      [
        "new-session",
        "-d",
        "-P",
        "-F",
        "#{window_id} #{pane_id}",
        "-s",
        sessionName,
        "-n",
        sessionName,
        ...sizeArgs,
        "-c",
        repoRoot,
      ],
      { cwd: repoRoot },
    );

    const [primaryWindowTarget, controlPaneTarget] = requireTargets(result.stdout);

    return {
      sessionName,
      controlPaneTarget,
      primaryWindowTarget,
    };
  }

  const windowResult = await runCommand(
    "tmux",
    ["list-windows", "-F", "#{window_id}", "-t", sessionName],
    { cwd: repoRoot },
  );
  const primaryWindowTarget = requireWindowTarget(windowResult.stdout);
  const paneResult = await runCommand(
    "tmux",
    ["list-panes", "-F", "#{pane_id}", "-t", primaryWindowTarget],
    { cwd: repoRoot },
  );
  const controlPaneTarget = requirePaneTarget(paneResult.stdout);

  await configurePrimaryWindow(repoRoot, primaryWindowTarget, controlPaneTarget);

  return {
    sessionName,
    controlPaneTarget,
    primaryWindowTarget,
  };
}

export async function writeWorkspaceRuntime(
  sessionFileContext: { repoRoot: string; sessionFile: string },
  workspace: CraigWorkspace,
  pages: ManagedPage[],
): Promise<void> {
  await writeSessionRuntime(
    { sessionFile: sessionFileContext.sessionFile },
    {
      sessionName: workspace.sessionName,
      controlPaneTarget: workspace.controlPaneTarget,
      primaryWindowTarget: workspace.primaryWindowTarget,
      managedPages: pages.map((page) => ({
        pageNumber: page.pageNumber,
        windowTarget: page.windowTarget,
        isPrimary: page.isPrimary,
      })),
      ui: getDefaultUiRuntime(),
      updatedAt: new Date().toISOString(),
    },
  );
}

export async function readWorkspaceRuntime(
  sessionFileContext: { repoRoot: string; sessionFile: string },
): Promise<CraigSessionRuntime | null> {
  return readSessionRuntime({ sessionFile: sessionFileContext.sessionFile });
}

export async function allocateTaskPane(
  repoRoot: string,
  worktreePath: string,
  pages: Array<{ pageNumber: number; windowTarget: string; isPrimary: boolean }>,
): Promise<ProvisionedPane> {
  const sessionName = getSessionNameForRepo(repoRoot);
  const sortedPages = [...pages].sort((left, right) => left.pageNumber - right.pageNumber);

  for (const page of sortedPages) {
    try {
      const paneId = await createPaneInWindow(repoRoot, page.windowTarget, worktreePath);
      await relayoutManagedWindow(repoRoot, page.windowTarget, page.isPrimary);

      return {
        paneId,
        persistedTarget: paneId,
        windowTarget: page.windowTarget,
        pageNumber: page.pageNumber,
        layoutSlot: await countWindowPanes(repoRoot, page.windowTarget),
      };
    } catch (error) {
      if (!isInsufficientPaneSpaceError(error)) {
        throw error;
      }
    }
  }

  const pageNumber = sortedPages.length + 1;
  const result = await runCommand(
    "tmux",
    ["new-window", "-d", "-P", "-F", "#{window_id} #{pane_id}", "-t", sessionName, "-c", worktreePath],
    { cwd: repoRoot },
  );
  const [windowTarget, paneId] = requireTargets(result.stdout);
  await relayoutManagedWindow(repoRoot, windowTarget, false);

  return {
    paneId,
    persistedTarget: paneId,
    windowTarget,
    pageNumber,
    layoutSlot: 1,
  };
}

async function createPaneInWindow(repoRoot: string, windowTarget: string, worktreePath: string): Promise<string> {
  const result = await runCommand(
    "tmux",
    ["split-window", "-d", "-P", "-F", "#{pane_id}", "-t", windowTarget, "-c", worktreePath],
    { cwd: repoRoot },
  );

  return result.stdout.trim();
}

async function configurePrimaryWindow(repoRoot: string, windowTarget: string, controlPaneTarget: string): Promise<void> {
  await relayoutManagedWindow(repoRoot, windowTarget, true, controlPaneTarget);
}

export async function relayoutManagedWindow(
  repoRoot: string,
  windowTarget: string,
  hasControlPane: boolean,
  controlPaneTarget?: string,
): Promise<void> {
  await runCommand("tmux", ["select-layout", "-t", windowTarget, "tiled"], { cwd: repoRoot });

  if (hasControlPane) {
    const target =
      controlPaneTarget ??
      (
        await runCommand("tmux", ["list-panes", "-F", "#{pane_id}", "-t", windowTarget], {
          cwd: repoRoot,
        })
      ).stdout
        .split(/\s+/)
        .map((line) => line.trim())
        .find((line) => line.length > 0);

    if (target) {
      await runCommand("tmux", ["resize-pane", "-t", target, "-y", `${CONTROL_PANE_HEIGHT}`], {
        cwd: repoRoot,
      });
    }
  }
}

export async function enablePaneLogging(paneId: string, logPath: string, cwd: string): Promise<void> {
  await runCommand(
    "tmux",
    ["pipe-pane", "-o", "-t", paneId, `cat >> ${shellEscape(logPath)}`],
    { cwd },
  );
}

export async function sendCommandToPane(paneId: string, command: string, cwd: string): Promise<void> {
  await runCommand("tmux", ["send-keys", "-t", paneId, command, "C-m"], { cwd });
}

export async function sendTextToPane(paneId: string, command: string, cwd: string): Promise<void> {
  await runCommand("tmux", ["send-keys", "-t", paneId, command], { cwd });
}

export async function clearPane(repoRoot: string, paneId: string): Promise<void> {
  await runCommand("tmux", ["send-keys", "-t", paneId, "C-l"], { cwd: repoRoot });
}

export async function focusPane(repoRoot: string, paneId: string, windowTarget?: string | null): Promise<void> {
  const sessionName = getSessionNameForRepo(repoRoot);

  if (windowTarget) {
    await runCommand("tmux", ["select-window", "-t", windowTarget], { cwd: repoRoot });
  } else {
    await runCommand("tmux", ["select-window", "-t", paneId], { cwd: repoRoot });
  }

  await runCommand("tmux", ["select-pane", "-t", paneId], { cwd: repoRoot });

  if (process.env.TMUX) {
    await runCommand("tmux", ["switch-client", "-t", sessionName], { cwd: repoRoot });
    return;
  }

  await runInteractiveTmuxCommand(repoRoot, ["attach-session", "-t", sessionName]);
}

export async function focusControlPane(repoRoot: string, controlPaneTarget: string, windowTarget: string): Promise<void> {
  await focusPane(repoRoot, controlPaneTarget, windowTarget);
}

export async function killPane(
  repoRoot: string,
  paneId: string,
  options?: { windowTarget?: string | null; hasControlPane?: boolean },
): Promise<void> {
  await runCommand("tmux", ["kill-pane", "-t", paneId], { cwd: repoRoot });

  if (options?.windowTarget) {
    await relayoutManagedWindow(repoRoot, options.windowTarget, options.hasControlPane ?? false);
  }
}

export function getSessionNameForRepo(repoRoot: string): string {
  const baseName = path.basename(repoRoot);
  const normalizedBase =
    baseName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "repo";
  const digest = createHash("sha1").update(repoRoot).digest("hex").slice(0, 8);

  return `${SESSION_PREFIX}-${normalizedBase}-${digest}`;
}

function getInitialSessionSizeArgs(): string[] {
  const size = readTerminalSize();
  if (!size) {
    return [];
  }

  return ["-x", `${size.columns}`, "-y", `${size.rows}`];
}

function readTerminalSize(): { columns: number; rows: number } | null {
  const candidates = [process.stdout, process.stderr, process.stdin];

  for (const candidate of candidates) {
    const columns = "columns" in candidate ? candidate.columns : undefined;
    const rows = "rows" in candidate ? candidate.rows : undefined;

    if (typeof columns === "number" && columns > 0 && typeof rows === "number" && rows > 0) {
      return { columns, rows };
    }
  }

  return null;
}

async function countWindowPanes(repoRoot: string, windowTarget: string): Promise<number> {
  const result = await runCommand("tmux", ["list-panes", "-F", "#{pane_id}", "-t", windowTarget], {
    cwd: repoRoot,
  });

  return toTargets(result.stdout).length;
}

function requireTargets(stdout: string): [string, string] {
  const targets = toTargets(stdout);

  if (targets.length < 2) {
    throw new Error("tmux did not return the expected window and pane targets for the Craig workspace.");
  }

  return [targets[0]!, targets[1]!];
}

function requireWindowTarget(stdout: string): string {
  const target = toTargets(stdout)[0];

  if (!target) {
    throw new Error("tmux did not return a window target for the craig session.");
  }

  return target;
}

function requirePaneTarget(stdout: string): string {
  const target = toTargets(stdout)[0];

  if (!target) {
    throw new Error("tmux did not return a pane target for the craig session.");
  }

  return target;
}

function toTargets(stdout: string): string[] {
  return stdout
    .split(/\s+/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function isInsufficientPaneSpaceError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message.toLowerCase();
  return message.includes("no space for new pane") || message.includes("not enough space for new pane");
}

async function runInteractiveTmuxCommand(repoRoot: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("tmux", args, {
      cwd: repoRoot,
      stdio: "inherit",
    });

    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`tmux ${args.join(" ")} failed with exit code ${code ?? "unknown"}.`));
    });
  });
}
