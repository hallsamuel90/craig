import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import type { CraigPaths } from "../../../state/craig-paths.js";
import { CraigError } from "../../error/index.js";

const LOCK_RETRY_DELAY_MS = 25;
const LOCK_TIMEOUT_MS = 30_000;
const UNOWNED_LOCK_STALE_MS = 5_000;

export async function withTaskLock<T>(
  paths: CraigPaths,
  taskId: string,
  operation: () => Promise<T>,
): Promise<T> {
  const locksDir = path.join(paths.runtimeDir, "task-locks");
  const lockPath = path.join(locksDir, `${taskId}.lock`);
  await mkdir(locksDir, { recursive: true });

  const startedAt = Date.now();
  while (true) {
    try {
      await mkdir(lockPath);
      try {
        await writeFile(
          path.join(lockPath, "owner.json"),
          JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }),
          "utf8",
        );
      } catch (error) {
        await rm(lockPath, { recursive: true, force: true });
        throw error;
      }
      break;
    } catch (error) {
      if (!isAlreadyExistsError(error)) {
        throw error;
      }
      if (await removeStaleLock(lockPath)) {
        continue;
      }
      if (Date.now() - startedAt >= LOCK_TIMEOUT_MS) {
        throw new CraigError(
          "OPERATION_TIMEOUT",
          `Timed out waiting to update task ${taskId}.`,
          { retryable: true, details: { taskId } },
        );
      }
      await delay(LOCK_RETRY_DELAY_MS);
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
    if (isProcessAlive(owner.pid)) {
      return false;
    }
    await rm(lockPath, { recursive: true, force: true });
    return true;
  }

  const lockStat = await stat(lockPath).catch(() => null);
  if (!lockStat || Date.now() - lockStat.mtimeMs < UNOWNED_LOCK_STALE_MS) {
    return false;
  }
  await rm(lockPath, { recursive: true, force: true });
  return true;
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: unknown }).code === "EPERM"
    );
  }
}

const isAlreadyExistsError = (error: unknown): error is { code: "EEXIST" } =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  (error as { code?: unknown }).code === "EEXIST";

const delay = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));
