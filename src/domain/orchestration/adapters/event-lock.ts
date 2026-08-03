import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import type { CraigPaths } from "../../../state/craig-paths.js";
import { CraigError } from "../../error/index.js";

const RETRY_MS = 20;
const TIMEOUT_MS = 30_000;
const UNOWNED_STALE_MS = 5_000;

export async function withEventJournalLock<T>(paths: CraigPaths, operation: () => Promise<T>): Promise<T> {
  const lockPath = path.join(paths.runtimeDir, "event-journal.lock");
  await mkdir(paths.runtimeDir, { recursive: true });
  const startedAt = Date.now();
  while (true) {
    try {
      await mkdir(lockPath);
      try {
        await writeFile(path.join(lockPath, "owner.json"), JSON.stringify({
          pid: process.pid,
          acquiredAt: new Date().toISOString(),
        }), "utf8");
      } catch (error) {
        await rm(lockPath, { recursive: true, force: true });
        throw error;
      }
      break;
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      if (await removeStaleLock(lockPath)) continue;
      if (Date.now() - startedAt >= TIMEOUT_MS) {
        throw new CraigError("OPERATION_TIMEOUT", "Timed out waiting for the event journal lock.", {
          retryable: true,
        });
      }
      await delay(RETRY_MS);
    }
  }
  try {
    return await operation();
  } finally {
    await rm(lockPath, { recursive: true, force: true });
  }
}

async function removeStaleLock(lockPath: string): Promise<boolean> {
  const owner = await readFile(path.join(lockPath, "owner.json"), "utf8")
    .then((value) => JSON.parse(value) as { pid?: unknown })
    .catch(() => null);
  if (owner && typeof owner.pid === "number") {
    if (isProcessAlive(owner.pid)) return false;
    await rm(lockPath, { recursive: true, force: true });
    return true;
  }
  const metadata = await stat(lockPath).catch(() => null);
  if (!metadata || Date.now() - metadata.mtimeMs < UNOWNED_STALE_MS) return false;
  await rm(lockPath, { recursive: true, force: true });
  return true;
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

const delay = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
