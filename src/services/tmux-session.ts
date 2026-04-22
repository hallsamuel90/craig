import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";

import { runCommand, runCommandAllowingFailure } from "../utils/exec.js";
import { shellEscape } from "../utils/shell-escape.js";

const SESSION_PREFIX = "craig";

export interface ProvisionedPane {
  paneId: string;
  persistedTarget: string;
}

export async function createPane(repoRoot: string, worktreePath: string): Promise<ProvisionedPane> {
  const sessionName = getSessionNameForRepo(repoRoot);
  const windowTarget = await resolveWindowTarget(repoRoot);

  const result = await createPaneInWindow(repoRoot, sessionName, windowTarget, worktreePath);
  const paneId = result.stdout.trim();
  await relayoutPaneWindow(repoRoot, paneId);

  return {
    paneId,
    persistedTarget: paneId,
  };
}

async function createPaneInWindow(
  repoRoot: string,
  sessionName: string,
  windowTarget: string,
  worktreePath: string,
): Promise<{ stdout: string; stderr: string }> {
  try {
    return await runCommand(
      "tmux",
      ["split-window", "-d", "-P", "-F", "#{pane_id}", "-t", windowTarget, "-c", worktreePath],
      { cwd: repoRoot },
    );
  } catch (error) {
    if (!isInsufficientPaneSpaceError(error)) {
      throw error;
    }

    return runCommand(
      "tmux",
      ["new-window", "-d", "-P", "-F", "#{pane_id}", "-t", sessionName, "-c", worktreePath],
      { cwd: repoRoot },
    );
  }
}

async function resolveWindowTarget(repoRoot: string): Promise<string> {
  const sessionName = getSessionNameForRepo(repoRoot);
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
        "#{window_id}",
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

    return requireWindowTarget(result.stdout);
  }

  const result = await runCommand("tmux", ["list-windows", "-F", "#{window_id}", "-t", sessionName], {
    cwd: repoRoot,
  });

  return requireWindowTarget(result.stdout);
}

function requireWindowTarget(stdout: string): string {
  const windowTarget = stdout
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);

  if (!windowTarget) {
    throw new Error("tmux did not return a window target for the craig session.");
  }

  return windowTarget;
}

function isInsufficientPaneSpaceError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message.toLowerCase();
  return message.includes("no space for new pane") || message.includes("not enough space for new pane");
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

async function relayoutPaneWindow(repoRoot: string, paneId: string): Promise<void> {
  await runCommand("tmux", ["select-layout", "-t", paneId, "tiled"], { cwd: repoRoot });
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

export async function focusPane(repoRoot: string, paneId: string): Promise<void> {
  const sessionName = getSessionNameForRepo(repoRoot);
  await runCommand("tmux", ["select-window", "-t", paneId], { cwd: repoRoot });
  await runCommand("tmux", ["select-pane", "-t", paneId], { cwd: repoRoot });

  if (process.env.TMUX) {
    await runCommand("tmux", ["switch-client", "-t", sessionName], { cwd: repoRoot });
    return;
  }

  await runInteractiveTmuxCommand(repoRoot, ["attach-session", "-t", sessionName]);
}

export async function killPane(repoRoot: string, paneId: string): Promise<void> {
  await runCommand("tmux", ["kill-pane", "-t", paneId], { cwd: repoRoot });
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
