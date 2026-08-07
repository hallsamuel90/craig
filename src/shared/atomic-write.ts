import { randomUUID } from "node:crypto";
import { chmod, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";

export async function atomicWriteJson(filePath: string, value: unknown, options: { mode?: number } = {}): Promise<void> {
  const directory = path.dirname(filePath);
  const tempFile = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`,
  );
  const handle = await open(tempFile, "w", options.mode);

  try {
    const payload = `${JSON.stringify(value, null, 2)}\n`;

    await handle.writeFile(payload, "utf8");
    await handle.sync();
    await handle.close();
    await rename(tempFile, filePath);
    if (options.mode !== undefined) await chmod(filePath, options.mode);
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(tempFile, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function readJsonIfExists<T>(filePath: string): Promise<T | null> {
  try {
    const payload = await readFile(filePath, "utf8");

    return JSON.parse(payload) as T;
  } catch (error) {
    if (isFileMissingError(error)) {
      return null;
    }

    throw error;
  }
}

function isFileMissingError(error: unknown): error is { code: string } {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    error.code === "ENOENT"
  );
}
