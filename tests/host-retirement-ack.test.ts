import { createServer, type Socket } from "node:net";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "vitest";
import { createCraigState } from "./test-helpers.js";
import { HostPool } from "../src/shell/runtime/host-pool.js";
import { newRuntimeRecord, writePrivateRecord } from "../src/shell/runtime/records.js";

test("lost retirement acknowledgement reconciles the host's committed marker instead of poisoning other generations", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "craig-retirement-ack-")).then((value) => realpath(value));
  const paths = await createCraigState(root, []); const previous = process.env.CRAIG_RUNTIME_CACHE; process.env.CRAIG_RUNTIME_CACHE = path.join(root, "cache");
  const host = { ...await newRuntimeRecord(paths, "host", "fixture"), hostRevision: "old" };
  const controller = { ...await newRuntimeRecord(paths, "control", "fixture"), hostRevision: "new" };
  const file = path.join(paths.runtimeDir, "hosts", `${host.instanceId}.json`); await mkdir(path.dirname(file), { recursive: true }); await writePrivateRecord(file, host);
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket); socket.on("close", () => sockets.delete(socket)); socket.on("error", () => undefined);
    let buffer = "";
    socket.on("data", (data) => { buffer += String(data); while (buffer.includes("\n")) {
      const end = buffer.indexOf("\n"); const request = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
      if (request.type === "shutdownIfUnused") { void writePrivateRecord(file, { ...host, retired: true }).then(() => socket.destroy()); continue; }
      socket.write(JSON.stringify({ id: request.id, ok: true, hostProtocol: 1, retirementProtocol: 1, instanceId: host.instanceId, sessions: [], activities: [], leaseCount: 0, pendingCreates: 0, handoffHoldCount: 0 }) + "\n");
    } });
  });
  await new Promise<void>((resolve) => server.listen(host.endpoint, resolve));
  const pool = new HostPool(paths, [host], controller, () => undefined);
  try {
    await pool.connect(); await pool.retireUnused();
    expect((await pool.inventory()).sessions).toEqual([]); expect((await pool.inventory()).hosts).toEqual([]);
  } finally {
    pool.close(); for (const socket of sockets) socket.destroy(); await new Promise<void>((resolve) => server.close(() => resolve()));
    if (previous === undefined) delete process.env.CRAIG_RUNTIME_CACHE; else process.env.CRAIG_RUNTIME_CACHE = previous;
    await rm(root, { recursive: true, force: true }); await rm(path.dirname(host.endpoint), { recursive: true, force: true });
  }
});
