import { replaceControlUnderLock, recoverReplacementUnderLock } from "./replacement.js";
import { errorService } from "../../domain/error/index.js";
import { readFile, lstat } from "node:fs/promises";
import path from "node:path";
import type { CraigPaths } from "../../state/craig-paths.js";
import { daemonStatus } from "./discovery.js";
import { acquireRuntimeLock } from "./ownership.js";
import { bootstrapSplitRuntime } from "./bootstrap.js";
import { readPrivateRecord, type RuntimeRecord } from "./records.js";
import { spawnPtyDaemonProcess } from "../pty-daemon-process.js";

// eslint-disable-next-line no-unused-vars
export async function ensureRuntimeRunning(paths: CraigPaths, spawnDaemon?: (workspaceRoot: string) => void): Promise<void> {
  const lockStarted = Date.now();
  let release: (() => Promise<void>) | undefined;
  while (!release) {
    try { release = await acquireRuntimeLock(paths, "lifecycle"); }
    catch (error) {
      if (Date.now() - lockStarted >= 30000) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  try {
    await recoverReplacementUnderLock(paths);
    // Preserve the launcher's bootstrap grace period: a concurrently invoked
    // server may not have published its endpoint/owner record yet.
    let status = await daemonStatus(paths);
    const discovering = Date.now();
    while (status.state === "absent" && Date.now() - discovering < 1000) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      status = await daemonStatus(paths);
    }
    if (status.state === "ready") {
      if (!spawnDaemon) {
        try { await replaceControlUnderLock(paths); }
        catch (error) {
          // Preparation failure or drain timeout must not take compatible
          // existing terminal access away. Explicit restart still reports the
          // error, and a released/unavailable owner cannot use this fallback.
          const retained = await daemonStatus(paths);
          if (retained.state !== "ready") throw error;
          await errorService.appendLogBestEffort(paths, { level: "warn", component: "daemon", event: "upgrade.blocked", message: error instanceof Error ? error.message : "Control replacement blocked; previous compatible service retained." });
        }
      }
      return;
    }
    const split = await readPrivateRecord<RuntimeRecord>(path.join(paths.runtimeDir, "control.json"));
    const guard = await readPrivateRecord<RuntimeRecord>(path.join(paths.runtimeDir, "guard.json"));
    if (split || guard) { await bootstrapSplitRuntime(paths); return; }
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
      if (spawnDaemon) spawnPtyDaemonProcess(paths, spawnDaemon);
      else await bootstrapSplitRuntime(paths);
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
