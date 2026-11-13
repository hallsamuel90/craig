import { spawn } from "node:child_process";
import { createServer, type Socket } from "node:net";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { describe, test, expect, vi } from "vitest";
import { getCraigPaths } from "../src/state/craig-paths.js";
import { SessionHost, type SessionHostOptions } from "../src/shell/runtime/session-host.js";
import { newRuntimeRecord } from "../src/shell/runtime/records.js";
import { RuntimeTransport, MAX_RUNTIME_FRAME_BYTES } from "../src/shell/runtime/wire.js";
import type { TerminalViewState } from "../src/shell/runtime/terminal/types.js";

async function fixture(options: SessionHostOptions = {}, command?: string[]) {
  const root = await mkdtemp(path.join(tmpdir(), "craig-host-contract-")).then((value) => realpath(value));
  const paths = getCraigPaths(root); const record = await newRuntimeRecord(paths, "host", "fixture-owned");
  const host = new SessionHost(record, options); const sockets = new Set<Socket>();
  const server = createServer((socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); host.handleConnection(socket); });
  await new Promise<void>((resolve) => server.listen(record.endpoint, resolve));
  const auth = { credential: record.credential, workspaceId: record.workspaceId, instanceId: record.instanceId, controllerId: "fixture-controller" };
  const connect = () => RuntimeTransport.connect(record.endpoint);
  let client = await connect();
  const request = (frame: Record<string, unknown>) => client.request({ ...auth, ...frame });
  await request({ type: "registerController", controllerPid: process.pid });
  await request({ type: "releaseHold", holdId: "recovery:fixture-controller" });
  const session = { taskId: "fixture", tabId: "fixture:agent", sessionId: "incarnation-1", creationId: "creation-1" };
  const ensure = () => request({ type: "ensure", session, size: { columns: 160, rows: 25 }, spec: { cwd: root, command: command ?? [process.execPath, "-e", "console.log('HOST_BUFFER_BEFORE_EXIT'); setTimeout(()=>process.exit(0),200)"] } });
  return { root, record, auth, client, request, connect, session, ensure, connectionCount: () => sockets.size, disconnect() { client.close(); }, async reconnect() { client = await connect(); await request({ type: "registerController", controllerPid: process.pid }); await request({ type: "releaseHold", holdId: "recovery:fixture-controller" }); }, async close() {
    await request({ type: "dispose", ...session }).catch(() => undefined); client.close();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true }); await rm(path.dirname(record.endpoint), { recursive: true, force: true });
  } };
}
const text = (view: unknown) => (view as TerminalViewState).rows.map((row) => row.segments.map((part) => part.text).join("")).join("\n");

describe("session-host contract", () => {
  test("creation replay retains an exited incarnation instead of relaunching it", async () => {
    const f = await fixture();
    try {
      const first = await f.ensure(); const pid = (first.sessions as Array<{ pid: number }>)[0]!.pid;
      await vi.waitFor(async () => expect(text((await f.request({ type: "snapshot", ...f.session })).view)).toContain("HOST_BUFFER_BEFORE_EXIT"));
      await vi.waitFor(async () => expect(((await f.request({ type: "enumerate" })).sessions as Array<{ status: string }>)[0]!.status).toBe("exited"));
      const replay = await f.ensure(); expect((replay.sessions as Array<{ pid: number }>)[0]!.pid).toBe(pid);
      expect(text(replay.view)).toContain("HOST_BUFFER_BEFORE_EXIT");
      await expect(f.request({ type: "ensure", session: { ...f.session, sessionId: "other" } })).rejects.toThrow("Creation id reuse");
    } finally { await f.close(); }
  });
  test("leases survive every socket closing and one client cannot release another view", async () => {
    const f = await fixture();
    try {
      await f.ensure();
      const a = await f.request({ type: "acquireView", ...f.session, viewId: "a", viewProof: "proof-a" });
      const b = await f.request({ type: "acquireView", ...f.session, viewId: "b", viewProof: "proof-b" });
      const other = await f.connect();
      await expect(other.request({ ...f.auth, type: "releaseView", ...f.session, viewId: "a", viewToken: b.viewToken })).rejects.toThrow("ownership");
      other.close();
      expect((await f.request({ type: "enumerate" })).leaseCount).toBe(2);
      await f.request({ type: "releaseView", ...f.session, viewId: "a", viewToken: a.viewToken });
      await f.request({ type: "releaseView", ...f.session, viewId: "a", viewToken: a.viewToken }); // lost release acknowledgement
      expect((await f.request({ type: "enumerate" })).leaseCount).toBe(1);
      await expect(f.request({ type: "shutdownIfUnused" })).rejects.toThrow("retained");
      await vi.waitFor(async () => expect(text((await f.request({ type: "view", ...f.session, viewId: "b", viewToken: b.viewToken })).view)).toContain("HOST_BUFFER_BEFORE_EXIT"));
      await f.request({ type: "hold", holdId: "handoff-fixture" });
      await f.request({ type: "dispose", ...f.session });
      expect((await f.request({ type: "enumerate" })).leaseCount).toBe(0);
      await expect(f.request({ type: "shutdownIfUnused" })).rejects.toThrow("retained");
      await f.request({ type: "releaseHold", holdId: "handoff-fixture" });
      expect((await f.request({ type: "enumerate" })).handoffHoldCount).toBe(0);
    } finally { await f.close(); }
  });
  test("a lost spawn acknowledgement is recovered by authoritative inventory without another process", async () => {
    let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; }); let first = true;
    const f = await fixture({ beforeReply: async (request) => { if (request.type === "ensure" && first) { first = false; await gate; } } });
    try {
      const lost = f.ensure().catch((error: unknown) => error);
      await vi.waitFor(async () => expect(((await f.request({ type: "enumerate" })).sessions as unknown[])).toHaveLength(1));
      const pid = ((await f.request({ type: "enumerate" })).sessions as Array<{ pid: number }>)[0]!.pid;
      f.disconnect(); expect(String(await lost)).toContain("acknowledgement");
      await f.reconnect(); const replay = await f.ensure();
      expect((replay.sessions as Array<{ pid: number }>)[0]!.pid).toBe(pid);
    } finally { release(); await f.close(); }
  });
  test("input with a lost acknowledgement is never automatically replayed", async () => {
    let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; }); let first = true;
    const f = await fixture({ beforeReply: async (request) => { if (request.type === "write" && first) { first = false; await gate; } } }, [process.execPath, "-e", "let count=0;require('node:readline').createInterface({input:process.stdin}).on('line',line=>console.log('COUNT:'+ (++count)+':'+line));console.log('HOST_BUFFER_BEFORE_EXIT')"]);
    try {
      await f.ensure(); const lost = f.request({ type: "write", ...f.session, input: "increment\r" }).catch((error: unknown) => error);
      await vi.waitFor(async () => expect(text((await f.request({ type: "snapshot", ...f.session })).view)).toContain("COUNT:1:increment"));
      f.disconnect(); expect(String(await lost)).toContain("acknowledgement");
      await f.reconnect();
      await f.request({ type: "write", ...f.session, input: "verify\r" });
      await vi.waitFor(async () => expect(text((await f.request({ type: "snapshot", ...f.session })).view)).toContain("COUNT:2:verify"));
      expect(text((await f.request({ type: "snapshot", ...f.session })).view)).not.toContain("COUNT:2:increment");
    } finally { release(); await f.close(); }
  });
  test("a slow subscriber is bounded and disconnects while native output and fresh snapshots continue", async () => {
    const f = await fixture({}, [process.execPath, "-e", "for(let i=0;i<40;i++)console.log('X'.repeat(150));setTimeout(()=>console.log('SLOW_SUBSCRIBER_FINAL'),500);setInterval(()=>{},1000)"]);
    const slow = await f.connect();
    try {
      await f.ensure(); await vi.waitFor(async () => expect(text((await f.request({ type: "snapshot", ...f.session })).view)).toContain("X".repeat(100)));
      await slow.request({ ...f.auth, type: "subscribe" }); slow.socket.pause();
      for (let id = 10000; id < 11000; id++) slow.socket.write(`${JSON.stringify({ ...f.auth, ...f.session, type: "snapshot", id })}\n`);
      await vi.waitFor(() => expect(f.connectionCount()).toBe(1), { timeout: 10000 });
      await vi.waitFor(async () => expect(text((await f.request({ type: "snapshot", ...f.session })).view)).toContain("SLOW_SUBSCRIBER_FINAL"), { timeout: 10000 });
      const resumed = await f.connect();
      try { expect(text((await resumed.request({ ...f.auth, ...f.session, type: "snapshot" })).view)).toContain("SLOW_SUBSCRIBER_FINAL"); } finally { resumed.close(); }
    } finally { slow.close(); await f.close(); }
  }, 15000);
  test("a durable creation reservation blocks shutdown even before a process or view exists", async () => {
    const f = await fixture();
    try {
      await f.request({ type: "reserveCreation", session: f.session });
      expect((await f.request({ type: "enumerate" })).pendingCreates).toBe(1);
      await expect(f.request({ type: "shutdownIfUnused" })).rejects.toThrow("pending creates");
      await f.request({ type: "completeCreation", creationId: f.session.creationId });
      expect((await f.request({ type: "enumerate" })).pendingCreates).toBe(0);
    } finally { await f.close(); }
  });
  test("a replacement atomically adopts a dead controller's bootstrap recovery hold", async () => {
    const f = await fixture();
    try {
      const old = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
      await new Promise<void>((resolve) => old.once("exit", () => resolve()));
      await f.request({ type: "registerController", controllerPid: old.pid });
      expect((await f.request({ type: "enumerate" })).handoffHoldCount).toBe(1);
      await f.request({ type: "registerController", controllerId: "replacement", controllerPid: process.pid });
      const request = (frame: Record<string, unknown>) => f.client.request({ ...f.auth, ...frame, controllerId: "replacement" });
      expect((await request({ type: "enumerate" })).handoffHoldCount).toBe(1);
      await expect(request({ type: "shutdownIfUnused" })).rejects.toThrow("retained");
      await request({ type: "releaseHold", holdId: "recovery:replacement" });
      expect((await request({ type: "enumerate" })).handoffHoldCount).toBe(0);
    } finally { await f.close(); }
  });
  test("retirement commits atomically against creation, logical attach and hold adoption", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const f = await fixture({ retire: () => gate });
    try {
      const retiring = f.request({ type: "shutdownIfUnused" });
      await vi.waitFor(async () => expect((await f.request({ type: "hello" })).retiring).toBe(true));
      await expect(f.ensure()).rejects.toThrow("retirement committed");
      await expect(f.request({ type: "reserveCreation", session: f.session })).rejects.toThrow("retirement committed");
      await expect(f.request({ type: "acquireView", ...f.session, viewId: "racing", viewProof: "racing" })).rejects.toThrow("retirement committed");
      await expect(f.request({ type: "hold", holdId: "handoff-race" })).rejects.toThrow("retirement committed");
      await expect(f.request({ type: "adoptHold", holdId: "handoff-race" })).rejects.toThrow("retirement committed");
      release(); await retiring;
    } finally { release(); await f.close(); }
  });
  test("exited logical views and adopted handoff holds prevent retirement until deliberate release", async () => {
    const f = await fixture();
    try {
      await f.ensure();
      const view = await f.request({ type: "acquireView", ...f.session, viewId: "retained", viewProof: "retained" });
      await vi.waitFor(async () => expect(((await f.request({ type: "enumerate" })).sessions as Array<{ status: string }>)[0]?.status).toBe("exited"));
      f.disconnect(); await f.reconnect();
      await expect(f.request({ type: "shutdownIfUnused" })).rejects.toThrow("retained");
      expect(text((await f.request({ type: "view", ...f.session, viewId: "retained", viewToken: view.viewToken })).view)).toContain("HOST_BUFFER_BEFORE_EXIT");
      await f.request({ type: "hold", holdId: "upgrade-transaction" });
      await f.request({ type: "releaseView", ...f.session, viewId: "retained", viewToken: view.viewToken });
      await f.request({ type: "adoptHold", holdId: "upgrade-transaction" });
      await expect(f.request({ type: "shutdownIfUnused" })).rejects.toThrow("retained");
      await f.request({ type: "releaseHold", holdId: "upgrade-transaction" });
      await f.request({ type: "shutdownIfUnused" });
    } finally { await f.close(); }
  });
  test("workspace/instance credentials and living-controller takeover are rejected", async () => {
    const f = await fixture();
    try {
      await expect(f.request({ type: "hello", workspaceId: "other-workspace" })).rejects.toThrow("identity");
      await expect(f.request({ type: "registerController", controllerId: "competitor", controllerPid: process.pid })).rejects.toThrow("still alive");
      await expect(f.request({ type: "write", sessionId: "missing", taskId: "wrong", tabId: "wrong", input: "x" })).rejects.toThrow("Unknown session");
      expect(MAX_RUNTIME_FRAME_BYTES).toBeLessThanOrEqual(2 * 1024 * 1024);
    } finally { await f.close(); }
  });
});
