import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import type { CraigPaths } from "../../../state/craig-paths.js";
import { CraigError } from "../../error/index.js";

export async function withFuryLock<T>(paths: CraigPaths, operation: () => Promise<T>): Promise<T> {
  const lockPath = path.join(paths.runtimeDir, "fury-store.lock");
  await mkdir(paths.runtimeDir, { recursive: true });
  const startedAt = Date.now();
  while (true) {
    try {
      await mkdir(lockPath);
      try {
        await writeFile(path.join(lockPath, "owner.json"), JSON.stringify({ pid: process.pid }), "utf8");
      } catch (error) {
        await rm(lockPath, { recursive: true, force: true });
        throw error;
      }
      break;
    } catch (error) {
      if (!isCode(error, "EEXIST")) throw error;
      const owner = await readFile(path.join(lockPath, "owner.json"), "utf8")
        .then((value) => JSON.parse(value) as { pid?: unknown }).catch(() => null);
      const metadata = await stat(lockPath).catch(() => null);
      if ((typeof owner?.pid === "number" && !isAlive(owner.pid)) || (!owner && metadata && Date.now() - metadata.mtimeMs > 5_000)) {
        await rm(lockPath, { recursive: true, force: true });
        continue;
      }
      if (Date.now() - startedAt > 30_000) {
        throw new CraigError("OPERATION_TIMEOUT", "Timed out waiting for the fury store lock.", { retryable: true });
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  try { return await operation(); }
  finally { await rm(lockPath, { recursive: true, force: true }); }
}

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return isCode(error, "EPERM"); }
}

const isCode = (error: unknown, code: string): error is { code: string } =>
  typeof error === "object" && error !== null && "code" in error && error.code === code;
