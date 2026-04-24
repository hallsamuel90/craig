import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";

import { runCommand, runCommandAllowingFailure } from "../utils/exec.js";
import { shellEscape } from "../utils/shell-escape.js";

const SESSION_PREFIX = "craig";

export interface ProvisionedSession {
  sessionName: string;
  paneId: string;
  windowTarget: string;
}

export async function createDetachedTaskSession(
  repoRoot: string,
  taskId: string,
  worktreePath: string,
): Promise<ProvisionedSession> {
  const sessionName = getSessionNameForTask(repoRoot, taskId);
  const sizeArgs = getInitialSessionSizeArgs();
  const result = await runCommand(
    "tmux",
    [
      "new-session",
      "-d",
      "-P",
      "-F",
      "#{session_name} #{window_id} #{pane_id}",
      "-s",
      sessionName,
      "-n",
      "runner",
      ...sizeArgs,
      "-c",
      worktreePath,
    ],
    { cwd: repoRoot },
  );
  const provisioned = requireSessionTargets(result.stdout);
  await configureHiddenSession(repoRoot, sessionName);

  return provisioned;
}

export async function ensureSessionAlive(repoRoot: string, sessionName: string): Promise<boolean> {
  const result = await runCommandAllowingFailure("tmux", ["has-session", "-t", sessionName], { cwd: repoRoot });
  return result.exitCode === 0;
}

export async function configureHiddenSession(repoRoot: string, sessionName: string): Promise<void> {
  const commands: string[][] = [
    ["set-option", "-t", sessionName, "status", "off"],
    ["set-option", "-t", sessionName, "detach-on-destroy", "off"],
    ["set-window-option", "-t", sessionName, "pane-border-status", "off"],
    ["set-window-option", "-t", sessionName, "aggressive-resize", "on"],
  ];

  for (const args of commands) {
    await runCommand("tmux", args, { cwd: repoRoot });
  }
}

export async function resizeSessionWindow(
  repoRoot: string,
  sessionName: string,
  size: { columns: number; rows: number },
): Promise<void> {
  await runCommand(
    "tmux",
    ["resize-window", "-t", sessionName, "-x", `${size.columns}`, "-y", `${size.rows}`],
    { cwd: repoRoot },
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

export async function enablePaneLogging(paneId: string, logPath: string, cwd: string): Promise<void> {
  await runCommand("tmux", ["pipe-pane", "-o", "-t", paneId, `cat >> ${shellEscape(logPath)}`], { cwd });
}

export async function focusPane(
  repoRoot: string,
  paneId: string,
  windowTarget?: string | null,
  sessionName?: string,
): Promise<void> {
  const resolvedSessionName = sessionName ?? getSessionNameForRepo(repoRoot);

  if (windowTarget) {
    await runCommand("tmux", ["select-window", "-t", windowTarget], { cwd: repoRoot });
  } else {
    await runCommand("tmux", ["select-window", "-t", paneId], { cwd: repoRoot });
  }

  await runCommand("tmux", ["select-pane", "-t", paneId], { cwd: repoRoot });

  if (process.env.TMUX) {
    await runCommand("tmux", ["switch-client", "-t", resolvedSessionName], { cwd: repoRoot });
    return;
  }

  await runInteractiveTmuxCommand(repoRoot, ["attach-session", "-t", resolvedSessionName]);
}

export async function focusControlPane(repoRoot: string, controlPaneTarget: string, windowTarget: string): Promise<void> {
  await focusPane(repoRoot, controlPaneTarget, windowTarget);
}

export async function relayoutManagedWindow(): Promise<void> {
  return;
}

export async function killSession(repoRoot: string, sessionName: string): Promise<void> {
  await runCommand("tmux", ["kill-session", "-t", sessionName], { cwd: repoRoot });
}

export async function killPane(
  repoRoot: string,
  paneId: string,
  options?: { windowTarget?: string | null; hasControlPane?: boolean },
): Promise<void> {
  void options;
  await runCommand("tmux", ["kill-pane", "-t", paneId], { cwd: repoRoot });
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

export function getSessionNameForTask(repoRoot: string, taskId: string): string {
  return `${getSessionNameForRepo(repoRoot)}-${taskId.toLowerCase()}`;
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

function requireSessionTargets(stdout: string): ProvisionedSession {
  const targets = toTargets(stdout);

  if (targets.length < 3) {
    throw new Error("tmux did not return the expected session, window, and pane targets for the Craig task session.");
  }

  return {
    sessionName: targets[0]!,
    windowTarget: targets[1]!,
    paneId: targets[2]!,
  };
}

function toTargets(stdout: string): string[] {
  return stdout
    .split(/\s+/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
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
