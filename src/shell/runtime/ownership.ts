import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createConnection } from "node:net";
import type { CraigPaths } from "../../state/craig-paths.js";
import { getPtyDaemonEndpoint } from "../pty-daemon-protocol.js";
import { processAlive } from "./discovery.js";

export async function acquireRuntimeLock(paths: CraigPaths, name: string, metadata: Record<string, unknown> = {}): Promise<() => Promise<void>> {
  await mkdir(paths.runtimeDir, { recursive: true });
  const lock = path.join(paths.runtimeDir, `${name}.lock`);
  const ownerPath = path.join(lock, "owner.json");
  const token = randomUUID();
  try { await mkdir(lock, { mode: 0o700 }); }
  catch (error) {
    if ((error as Error & { code?: string }).code !== "EEXIST") throw error;
    const before = await lstat(lock);
    if (before.isSymbolicLink() || before.uid !== process.getuid?.()) throw new Error("Unsafe runtime lock owner.");
    const ownerMetadata = await lstat(ownerPath).catch(() => null);
    if (ownerMetadata && (!ownerMetadata.isFile() || ownerMetadata.uid !== process.getuid?.())) throw new Error("Unsafe runtime lock record.");
    const text = await readFile(ownerPath, "utf8").catch(() => null);
    const owner = text ? JSON.parse(text) as { pid: number } : null;
    if (!owner || !Number.isInteger(owner.pid) || owner.pid <= 0 || processAlive(owner.pid)) throw new Error("Runtime lifecycle lock is owned or ambiguous; owner preserved.");
    await writeFile(path.join(lock, "reaping"), token, { flag: "wx", mode: 0o600 });
    const after = await lstat(lock);
    if (before.ino !== after.ino || before.dev !== after.dev || await readFile(ownerPath, "utf8") !== text) throw new Error("Runtime lock owner changed.");
    await rm(lock, { recursive: true });
    return acquireRuntimeLock(paths, name, metadata);
  }
  const text = JSON.stringify({ ...metadata, pid: process.pid, token });
  await writeFile(ownerPath, text, { mode: 0o600, flag: "wx" });
  return async () => {
    if (await readFile(ownerPath, "utf8").catch(() => null) === text) await rm(lock, { recursive: true });
  };
}

// Caller holds daemon-owner.lock. A timeout is never evidence of a dead owner.
export async function cleanupDeadEndpoint(paths: CraigPaths): Promise<void> {
  const endpoint = getPtyDaemonEndpoint(paths);
  const socketBefore = await lstat(endpoint.socketPath).catch(() => null);
  const pidBefore = await lstat(endpoint.pidPath).catch(() => null);
  for (const entry of [socketBefore, pidBefore]) {
    if (entry && (entry.isSymbolicLink() || entry.uid !== process.getuid?.())) throw new Error("Unsafe runtime endpoint ownership.");
  }
  if (socketBefore && !socketBefore.isSocket()) throw new Error("Runtime endpoint is not a socket.");
  if (pidBefore && !pidBefore.isFile()) throw new Error("Runtime PID record is not a regular file.");
  const pidText = await readFile(endpoint.pidPath, "utf8").catch(() => null);
  if (pidText !== null) {
    const pid = Number(pidText.trim());
    if (!Number.isInteger(pid) || pid <= 0 || processAlive(pid)) throw new Error("Runtime owner is live or ambiguous; endpoint preserved.");
  }
  if (socketBefore) {
    const refused = await new Promise<boolean>((resolve) => {
      const socket = createConnection(endpoint.socketPath);
      const timer = setTimeout(() => { socket.destroy(); resolve(false); }, 500);
      socket.once("connect", () => { clearTimeout(timer); socket.destroy(); resolve(false); });
      socket.once("error", (error: Error & { code?: string }) => { clearTimeout(timer); socket.destroy(); resolve(error.code === "ECONNREFUSED" || error.code === "ENOENT"); });
    });
    if (!refused) throw new Error("Live or unresponsive runtime listener preserved.");
  }
  for (const [file, before] of [[endpoint.socketPath, socketBefore], [endpoint.pidPath, pidBefore]] as const) {
    const after = await lstat(file).catch(() => null);
    if (before?.ino !== after?.ino || before?.dev !== after?.dev) throw new Error("Runtime endpoint changed during cleanup.");
  }
  if (await readFile(endpoint.pidPath, "utf8").catch(() => null) !== pidText) throw new Error("Runtime owner changed during cleanup.");
  if (socketBefore) await rm(endpoint.socketPath);
  if (pidBefore) await rm(endpoint.pidPath);
}
