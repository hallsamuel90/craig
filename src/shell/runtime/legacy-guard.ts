import { processAlive } from "./discovery.js";
import { readPrivateRecord } from "./records.js";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { createServer, type Socket } from "node:net";
import { readFile, rm, lstat, writeFile } from "node:fs/promises";
import type { CraigPaths } from "../../state/craig-paths.js";
import { getPtyDaemonEndpoint } from "../pty-daemon-protocol.js";
import { acquireRuntimeLock, cleanupDeadEndpoint } from "./ownership.js";
import { readRuntimeFrames, writeRuntimeFrame } from "./wire.js";
import type { RuntimeRecord } from "./records.js";
import { LEGACY_REJECTION_PROTOCOL } from "./compatibility.js";

/** Resident exclusion boundary. Never forwards a legacy mutation to a host. */
export async function serveLegacyGuard(paths: CraigPaths, record: RuntimeRecord): Promise<void> {
  const endpoint = getPtyDaemonEndpoint(paths);
  const release = await acquireRuntimeLock(paths, "daemon-owner");
  let ownedInode: number | undefined;
  let shutdown: (() => void) | undefined;
  const clients = new Set<Socket>();
  const server = createServer((socket) => {
    clients.add(socket); socket.on("close", () => clients.delete(socket)); socket.on("error", () => undefined);
    readRuntimeFrames(socket, (frame) => { void (async () => {
      if (frame.type === "shutdownGuard" && frame.credential === record.credential && frame.instanceId === record.instanceId && frame.workspaceId === record.workspaceId) {
        const control = await readPrivateRecord<RuntimeRecord>(path.join(paths.runtimeDir, "control.json"));
        const hosts = await readdir(path.join(paths.runtimeDir, "hosts"));
        const hostRecords = await Promise.all(hosts.filter((name) => name.endsWith(".json")).map((name) => readPrivateRecord<RuntimeRecord>(path.join(paths.runtimeDir, "hosts", name))));
        if ((control && processAlive(control.pid)) || hostRecords.some((host) => !host || processAlive(host.pid))) {
          writeRuntimeFrame(socket, { id: frame.id, ok: false, error: "Control or host ownership remains; guard retained." }); return;
        }
        writeRuntimeFrame(socket, { id: frame.id, ok: true }); setImmediate(() => shutdown?.()); return;
      }
      if (frame.type === "ping") writeRuntimeFrame(socket, { id: frame.id, ok: true, protocolVersion: LEGACY_REJECTION_PROTOCOL, role: "guard", workspaceId: record.workspaceId, instanceId: record.instanceId, pid: process.pid });
      else writeRuntimeFrame(socket, { id: frame.id, ok: false, error: "This workspace uses session-preserving Craig. Use an updated binary; legacy writes, shutdown and pruning are rejected." });
    })().catch(() => writeRuntimeFrame(socket, { id: frame.id, ok: false, error: "Unverifiable ownership; guard retained." })); });
  });
  try {
    await cleanupDeadEndpoint(paths);
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(endpoint.socketPath, resolve); });
    ownedInode = (await lstat(endpoint.socketPath)).ino;
    await writeFile(endpoint.pidPath, String(process.pid), { mode: 0o600 });
    // Ordinary service exit never asks the guard to stop. Signals are deliberate
    // process termination, used only by fixture teardown or explicit repair.
    await new Promise<void>((resolve) => {
      const close = () => { for (const client of clients) client.destroy(); server.close(() => resolve()); };
      shutdown = close;
      process.once("SIGTERM", close); process.once("SIGINT", close);
    });
  } finally {
    if (server.listening) server.close();
    if ((await lstat(endpoint.socketPath).catch(() => null))?.ino === ownedInode) await rm(endpoint.socketPath, { force: true });
    if (await readFile(endpoint.pidPath, "utf8").catch(() => null) === String(process.pid)) await rm(endpoint.pidPath, { force: true });
    await release();
  }
}
