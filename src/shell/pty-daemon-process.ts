import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import path from "node:path";

import { resolveExecutablePath } from "../shared/command-path.js";
import type { CraigPaths } from "../state/craig-paths.js";

/* eslint-disable-next-line no-unused-vars */
export function spawnPtyDaemonProcess(paths: CraigPaths, spawnDaemon?: (workspaceRoot: string) => void): void {
  if (spawnDaemon) {
    spawnDaemon(paths.workspaceRoot);
    return;
  }

  const { command, args } = daemonSpawnCommand(paths.workspaceRoot);
  const logFd = openSync(path.join(paths.runtimeDir, "pty-daemon.log"), "a");
  const child = (() => {
    try {
      return spawn(command, args, {
        cwd: paths.workspaceRoot,
        detached: true,
        stdio: ["ignore", logFd, logFd],
        env: process.env,
      });
    } finally {
      closeSync(logFd);
    }
  })();
  child.unref();
}

function daemonSpawnCommand(workspaceRoot: string): { command: string; args: string[] } {
  const entrypoint = process.argv[1];
  if (entrypoint?.endsWith(".ts")) {
    const localTsx = path.resolve(path.dirname(entrypoint), "..", "node_modules", ".bin", "tsx");
    return { command: resolveExecutablePath("tsx") ?? localTsx, args: [entrypoint, "__craig-daemon", workspaceRoot] };
  }
  if (!entrypoint) throw new Error("Craig cannot resolve its daemon entrypoint.");
  return { command: process.execPath, args: [...process.execArgv, entrypoint, "__craig-daemon", workspaceRoot] };
}
