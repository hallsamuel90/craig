import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import type { CraigPaths } from "../state/craig-paths.js";
import { CraigError } from "../domain/error/index.js";

export interface OrchestrationLeaderLease {
  release(): Promise<void>;
}

export async function acquireOrchestrationLeader(paths: CraigPaths): Promise<OrchestrationLeaderLease> {
  const lockPath = path.join(paths.runtimeDir, "orchestration-supervisor.lock");
  await mkdir(paths.runtimeDir, { recursive: true });
  try {
    await mkdir(lockPath);
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
    const owner = await readFile(path.join(lockPath, "owner.json"), "utf8")
      .then((value) => JSON.parse(value) as { pid?: unknown })
      .catch(() => null);
    const metadata = await stat(lockPath).catch(() => null);
    if (
      (typeof owner?.pid === "number" && !isProcessAlive(owner.pid)) ||
      (!owner && metadata && Date.now() - metadata.mtimeMs >= 5_000)
    ) {
      await rm(lockPath, { recursive: true, force: true });
      return acquireOrchestrationLeader(paths);
    }
    throw new CraigError("COMMAND_STATE_CONFLICT", "Another orchestration supervisor already leads this workspace.", {
      details: { ownerPid: owner?.pid ?? null },
    });
  }
  try {
    await writeFile(path.join(lockPath, "owner.json"), JSON.stringify({
      pid: process.pid,
      acquiredAt: new Date().toISOString(),
    }), "utf8");
  } catch (error) {
    await rm(lockPath, { recursive: true, force: true });
    throw error;
  }
  let released = false;
  return {
    async release() {
      if (released) return;
      released = true;
      await rm(lockPath, { recursive: true, force: true });
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

const isAlreadyExists = (error: unknown): error is { code: "EEXIST" } =>
  typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
