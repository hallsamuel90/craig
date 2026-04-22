import { spawn } from "node:child_process";

import { runCommand, runCommandAllowingFailure } from "../utils/exec.js";
import { shellEscape } from "../utils/shell-escape.js";

const SESSION_NAME = "craig";

export interface ProvisionedPane {
  paneId: string;
  persistedTarget: string;
}

export async function createPane(repoRoot: string, worktreePath: string): Promise<ProvisionedPane> {
  const windowTarget = await resolveWindowTarget(repoRoot);

  const result = await runCommand(
    "tmux",
    ["split-window", "-d", "-P", "-F", "#{pane_id}", "-t", windowTarget, "-c", worktreePath],
    { cwd: repoRoot },
  );
  const paneId = result.stdout.trim();

  return {
    paneId,
    persistedTarget: paneId,
  };
}

async function resolveWindowTarget(repoRoot: string): Promise<string> {
  const sessionState = await runCommandAllowingFailure("tmux", ["has-session", "-t", SESSION_NAME], {
    cwd: repoRoot,
  });

  if (sessionState.exitCode !== 0) {
    const result = await runCommand(
      "tmux",
      ["new-session", "-d", "-P", "-F", "#{window_id}", "-s", SESSION_NAME, "-n", SESSION_NAME, "-c", repoRoot],
      { cwd: repoRoot },
    );

    return requireWindowTarget(result.stdout);
  }

  const result = await runCommand("tmux", ["list-windows", "-F", "#{window_id}", "-t", SESSION_NAME], {
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
  await runCommand("tmux", ["select-pane", "-t", paneId], { cwd: repoRoot });

  if (process.env.TMUX) {
    await runCommand("tmux", ["switch-client", "-t", SESSION_NAME], { cwd: repoRoot });
    return;
  }

  await runInteractiveTmuxCommand(repoRoot, ["attach-session", "-t", SESSION_NAME]);
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
