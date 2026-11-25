import { acquireRuntimeLock } from "./runtime/ownership.js";
import { readFile, stat, utimes } from "node:fs/promises";
import path from "node:path";

import type { CraigPaths } from "../state/craig-paths.js";
import { CraigError } from "../domain/error/index.js";
import { PTY_DAEMON_PROTOCOL_VERSION } from "./pty-daemon-protocol.js";

export interface OrchestrationLeaderLease {
  release(): Promise<void>;
  heartbeat(): Promise<void>;
}

export async function hasLiveOrchestrationSupervisor(paths: CraigPaths): Promise<boolean> {
  const ownerPath = path.join(paths.runtimeDir, "orchestration-supervisor.lock", "owner.json");
  try {
    const [owner, metadata] = await Promise.all([
      readFile(ownerPath, "utf8").then((value) => JSON.parse(value) as { pid?: unknown; protocolVersion?: unknown }),
      stat(ownerPath),
    ]);
    const age = Date.now() - metadata.mtimeMs;
    return owner.protocolVersion === PTY_DAEMON_PROTOCOL_VERSION &&
      age >= -1_000 && age < 5_000 && typeof owner.pid === "number" && isProcessAlive(owner.pid);
  } catch {
    return false;
  }
}

export async function acquireOrchestrationLeader(paths: CraigPaths): Promise<OrchestrationLeaderLease> {
  const lockPath = path.join(paths.runtimeDir, "orchestration-supervisor.lock");
  let release: () => Promise<void>;
  try {
    release = await acquireRuntimeLock(paths, "orchestration-supervisor", { protocolVersion: PTY_DAEMON_PROTOCOL_VERSION });
  } catch {
    throw new CraigError("COMMAND_STATE_CONFLICT", "Another orchestration supervisor owns this workspace or its owner is ambiguous.", {});
  }
  let released = false;
  return {
    async heartbeat() {
      if (released) return;
      const now = new Date();
      await utimes(path.join(lockPath, "owner.json"), now, now);
    },
    async release() {
      if (released) return;
      released = true;
      await release();
    },
  };
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return typeof error === "object" && error !== null && "code" in error && error.code === "EPERM";
  }
}
