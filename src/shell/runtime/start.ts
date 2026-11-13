import { errorService } from "../../domain/error/index.js";
import { readFile, lstat } from "node:fs/promises";
import path from "node:path";
import type { CraigPaths } from "../../state/craig-paths.js";
import { daemonStatus } from "./discovery.js";
import { acquireRuntimeLock } from "./ownership.js";
import { spawnPtyDaemonProcess } from "../pty-daemon-process.js";

// eslint-disable-next-line no-unused-vars
export async function ensureRuntimeRunning(paths: CraigPaths, spawnDaemon?: (workspaceRoot: string) => void): Promise<void> {
  const lockStarted = Date.now();
  let release: (() => Promise<void>) | undefined;
  while (!release) {
    try { release = await acquireRuntimeLock(paths, "lifecycle"); }
    catch (error) {
      if (Date.now() - lockStarted >= 5000) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  try {
    // Preserve the launcher's bootstrap grace period: a concurrently invoked
    // server may not have published its endpoint/owner record yet.
    let status = await daemonStatus(paths);
    const discovering = Date.now();
    while (status.state === "absent" && Date.now() - discovering < 1000) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      status = await daemonStatus(paths);
    }
    if (status.state === "ready") return;
    if (status.state !== "absent") {
      await errorService.appendLogBestEffort(paths, { level: "warn", component: "daemon", event: "upgrade.blocked", message: status.reason ?? "Runtime owner preserved.", details: { protocolVersion: status.runtime?.protocolVersion ?? "unknown", sessionCount: status.runtime?.sessionCount ?? "unknown" } });
      throw new Error(status.reason ?? "Workspace runtime is unavailable; existing sessions are preserved.");
    }
    let spawned = false;
    const trySpawn = async () => {
      if (spawned) return;
      const owner = await lstat(path.join(paths.runtimeDir, "daemon-owner.lock")).catch(() => null);
      if (owner) {
        let releaseOwner: (() => Promise<void>) | undefined;
        try { releaseOwner = await acquireRuntimeLock(paths, "daemon-owner"); }
        catch { return; } // A live owner may still be binding or exiting.
        await releaseOwner();
      }
      spawnPtyDaemonProcess(paths, spawnDaemon);
      spawned = true;
    };
    await trySpawn();
    const started = Date.now();
    while (Date.now() - started < 5000) {
      const next = await daemonStatus(paths);
      if (next.state === "ready") return;
      if (next.state === "absent") await trySpawn();
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const log = await readFile(path.join(paths.runtimeDir, "pty-daemon.log"), "utf8").catch(() => "");
    throw new Error(`Craig PTY daemon did not start.${log ? `\n${log.slice(-2000)}` : ""}`);
  } finally { await release(); }
}
