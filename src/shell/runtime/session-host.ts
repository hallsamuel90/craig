import { randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type Socket } from "node:net";
import type { CraigPaths } from "../../state/craig-paths.js";
import { PtyRuntime, type PtyRuntimeOptions, type PtySessionSpec, type PtySize } from "./session-core.js";
import { readPrivateRecord, writePrivateRecord, type RuntimeRecord } from "./records.js";
import path from "node:path";
import { processAlive } from "./discovery.js";
import { readRuntimeFrames, writeRuntimeFrame, type RuntimeFrame } from "./wire.js";

import { createGhosttyEmulator } from "./terminal/ghostty/emulator.js";
import { createTerminalEmulator } from "./terminal/terminal-emulator.js";

export const SESSION_HOST_PROTOCOL = 1;
interface SessionIdentity { taskId: string; tabId: string; sessionId: string; creationId: string }
interface ViewLease { sessionId: string; viewId: string; proof: string; token: string; scrollback: number }
interface Controller { instanceId: string; pid: number }

/** Owns raw PTYs/screens only. No task/config/runner/orchestration policy. */
export interface SessionHostOptions extends Partial<PtyRuntimeOptions> {
  retire?: () => Promise<void>;
  // eslint-disable-next-line no-unused-vars
  beforeReply?: (request: RuntimeFrame, result: RuntimeFrame) => Promise<void>;
}
export class SessionHost {
  private readonly runtime: PtyRuntime;
  private readonly sessions = new Map<string, SessionIdentity>();
  private readonly creations = new Map<string, SessionIdentity>();
  private readonly leases = new Map<string, ViewLease>();
  private readonly viewProofs = new Map<string, string>();
  private readonly released = new Map<string, string>();
  private readonly holds = new Set<string>();
  private readonly subscribers = new Set<Socket>();
  private controller: Controller | null = null;
  private revision = 0;
  private retiring = false;
  private pendingCreates = 0;
  private readonly reservedCreations = new Map<string, SessionIdentity>();
  private readonly dirty = new Set<string>();
  private updateTimer: ReturnType<typeof setTimeout> | null = null;
  onShutdown: (() => void) | undefined;

  // eslint-disable-next-line no-unused-vars
  constructor(readonly record: RuntimeRecord, private readonly options: SessionHostOptions = {}) {
    this.runtime = new PtyRuntime({ ...options, workspaceRoot: "/", retainExited: true, directCommand: true, activityEnabled: true,
      onUpdate: ({ tabId }) => this.changed(tabId), onActivity: (snapshot) => this.changed(snapshot.tabId), onActivityRemoved: (tabId) => this.changed(tabId) });
  }
  handleConnection(socket: Socket): void {
    socket.on("error", () => undefined);
    readRuntimeFrames(socket, (frame) => { void this.handle(socket, frame); });
    socket.on("close", () => this.subscribers.delete(socket));
  }
  private changed(sessionId: string): void {
    this.revision++; this.dirty.add(sessionId);
    if (this.updateTimer) return;
    this.updateTimer = setTimeout(() => {
      this.updateTimer = null;
      for (const socket of this.subscribers) writeRuntimeFrame(socket, { type: "changed", instanceId: this.record.instanceId, revision: this.revision, sessionIds: [...this.dirty] });
      this.dirty.clear();
    }, 16);
  }
  private authenticated(frame: RuntimeFrame): void {
    const credential = typeof frame.credential === "string" ? frame.credential : "";
    const expected = this.record.credential;
    if (frame.workspaceId !== this.record.workspaceId || frame.instanceId !== this.record.instanceId || credential.length !== expected.length || !timingSafeEqual(Buffer.from(credential), Buffer.from(expected))) throw new Error("Host identity or credential rejected.");
  }
  private assertController(frame: RuntimeFrame): void {
    if (!this.controller || frame.controllerId !== this.controller.instanceId) throw new Error("Only the authenticated active controller may mutate sessions.");
  }
  private identity(frame: RuntimeFrame): SessionIdentity {
    const session = this.sessions.get(String(frame.sessionId));
    if (!session || session.taskId !== frame.taskId || session.tabId !== frame.tabId) throw new Error("Unknown session incarnation.");
    return session;
  }
  private lease(frame: RuntimeFrame): ViewLease {
    const lease = this.leases.get(String(frame.viewId));
    if (!lease || lease.token !== frame.viewToken || lease.sessionId !== frame.sessionId) throw new Error("View ownership rejected.");
    return lease;
  }
  private inventory(): RuntimeFrame {
    const facts = new Map(this.runtime.getProcessFacts().map((fact) => [fact.sessionId, fact]));
    return { keyEncodingProtocol: 1, retirementProtocol: 1, retiring: this.retiring, hostProtocol: SESSION_HOST_PROTOCOL, hostRevision: this.record.hostRevision ?? "fixture", instanceId: this.record.instanceId, revision: this.revision, pid: process.pid,
      sessions: [...this.sessions.values()].map((session) => ({ ...session, ...facts.get(session.sessionId) })),
      activities: this.runtime.getActivitySnapshots().map((snapshot) => ({ ...snapshot, tabId: this.sessions.get(snapshot.tabId)?.tabId ?? snapshot.tabId })),
      leases: [...this.leases.values()].map(({ sessionId, viewId }) => ({ sessionId, viewId })), holds: [...this.holds], leaseCount: this.leases.size, handoffHoldCount: this.holds.size, pendingCreates: this.pendingCreates + this.reservedCreations.size };
  }
  private async handle(socket: Socket, frame: RuntimeFrame): Promise<void> {
    try {
      this.authenticated(frame);
      if (this.retiring && frame.type !== "hello") throw new Error("Host retirement committed; no new mutations accepted.");
      let result: RuntimeFrame;
      if (frame.type === "registerController") {
        const pid = frame.controllerPid;
        if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0 || typeof frame.controllerId !== "string") throw new Error("Invalid controller identity.");
        if (this.controller && this.controller.instanceId !== frame.controllerId && processAlive(this.controller.pid)) throw new Error("Previous controller is still alive; takeover denied.");
        const previousController = this.controller;
        this.holds.add(`recovery:${frame.controllerId}`);
        this.controller = { instanceId: frame.controllerId, pid };
        // Transfer the crash-recovery hold atomically after proving the old PID
        // dead. A crash before controller readiness must not leak that hold.
        if (previousController && previousController.instanceId !== frame.controllerId) this.holds.delete(`recovery:${previousController.instanceId}`);
        result = this.inventory();
      } else if (frame.type === "hello") result = this.inventory();
      else {
        this.assertController(frame);
        result = await this.operation(socket, frame);
      }
      await this.options.beforeReply?.(frame, result);
      writeRuntimeFrame(socket, { ...result, id: frame.id, ok: true });
    } catch (error) { writeRuntimeFrame(socket, { id: frame.id, ok: false, error: error instanceof Error ? error.message : "Host request failed." }); }
  }
  private operation(socket: Socket, frame: RuntimeFrame): RuntimeFrame | Promise<RuntimeFrame> {
    switch (frame.type) {
      case "enumerate": return this.inventory();
      case "subscribe": this.subscribers.add(socket); return this.inventory();
      case "hold": this.holds.add(String(frame.holdId)); return {};
      case "adoptHold": { if (!this.holds.has(String(frame.holdId))) throw new Error("Handoff hold is missing; readiness blocked."); return this.inventory(); }
      case "releaseHold": this.holds.delete(String(frame.holdId)); return {};
      case "reserveCreation": {
        const session = frame.session as SessionIdentity;
        if (!session || ![session.taskId, session.tabId, session.sessionId, session.creationId].every((part) => typeof part === "string" && part.length > 0 && part.length <= 256)) throw new Error("Invalid creation reservation.");
        const reservationId = typeof frame.reservationId === "string" ? frame.reservationId : session.creationId;
        const previous = this.reservedCreations.get(reservationId) ?? this.creations.get(session.creationId);
        if (previous && JSON.stringify(previous) !== JSON.stringify(session)) throw new Error("Creation reservation conflict.");
        this.reservedCreations.set(reservationId, session); return {};
      }
      case "completeCreation": this.reservedCreations.delete(String(frame.reservationId ?? frame.creationId)); return {};
      case "ensure": {
        const identity = frame.session as SessionIdentity;
        if (!identity || ![identity.taskId, identity.tabId, identity.sessionId, identity.creationId].every((value) => typeof value === "string" && value.length > 0 && value.length <= 256)) throw new Error("Malformed session identity.");
        const previous = this.creations.get(identity.creationId);
        if (previous && JSON.stringify(previous) !== JSON.stringify(identity)) throw new Error("Creation id reuse with a different session is forbidden.");
        const size = frame.size as PtySize;
        if (!size || !Number.isInteger(size.columns) || !Number.isInteger(size.rows) || size.columns < 1 || size.rows < 1 || size.columns > 1000 || size.rows > 1000) throw new Error("Invalid terminal dimensions.");
        const existing = this.sessions.get(identity.sessionId);
        if (existing && JSON.stringify(existing) !== JSON.stringify(identity)) throw new Error("Session identity conflict.");
        if (previous && !existing) throw new Error("This creation was explicitly disposed; use a new incarnation.");
        if (!existing) {
          const size = frame.size as PtySize; const spec = frame.spec as PtySessionSpec;
          if (!size || !Number.isInteger(size.columns) || !Number.isInteger(size.rows) || size.columns < 1 || size.rows < 1 || size.columns > 1000 || size.rows > 1000 || !spec || typeof spec.cwd !== "string" || !Array.isArray(spec.command) || !spec.command.every((part) => typeof part === "string")) throw new Error("Invalid session creation request.");
          this.pendingCreates++;
          try {
            if (spec.terminalBackend !== undefined && spec.terminalBackend !== "xterm" && spec.terminalBackend !== "ghostty") throw new Error("Unsupported terminal backend.");
            this.runtime.ensureSession(identity.taskId, identity.sessionId, size, spec, spec.terminalBackend === "ghostty" ? createGhosttyEmulator : this.options.createEmulator ?? createTerminalEmulator);
            this.sessions.set(identity.sessionId, identity); this.creations.set(identity.creationId, identity); this.changed(identity.sessionId);
          } finally { this.pendingCreates--; }
        }
        this.runtime.resizeSession(identity.sessionId, size);
        this.changed(identity.sessionId);
        return { view: this.runtime.getViewState(identity.sessionId), ...this.inventory() };
      }
      case "acquireView": {
        this.identity(frame);
        if (typeof frame.viewId !== "string" || typeof frame.viewProof !== "string" || frame.viewId.length > 256 || frame.viewProof.length > 256) throw new Error("Invalid view identity.");
        const existing = this.leases.get(frame.viewId);
        const proof = this.viewProofs.get(frame.viewId);
        if (proof && proof !== frame.viewProof) throw new Error("View identity belongs to another client.");
        this.viewProofs.set(frame.viewId, frame.viewProof);
        if (existing && (existing.proof !== frame.viewProof || existing.sessionId !== frame.sessionId)) throw new Error("View is owned by another client.");
        const lease = existing ?? { sessionId: String(frame.sessionId), viewId: frame.viewId, proof: frame.viewProof, token: randomUUID(), scrollback: 0 };
        this.leases.set(lease.viewId, lease);
        return { viewToken: lease.token, revision: this.revision, view: this.runtime.getViewAt(lease.sessionId, lease.scrollback) };
      }
      case "releaseView": {
        const released = this.released.get(String(frame.viewId));
        if (released === frame.viewToken) return {};
        const lease = this.lease(frame); this.leases.delete(lease.viewId); this.released.set(lease.viewId, lease.token); return {};
      }
      case "snapshot": { this.identity(frame); return { revision: this.revision, view: this.runtime.getViewAt(String(frame.sessionId), typeof frame.scrollback === "number" ? frame.scrollback : 0), screen: this.runtime.getScreenText(String(frame.sessionId)) }; }
      case "view": { const lease = this.lease(frame); return { revision: this.revision, view: this.runtime.getViewAt(lease.sessionId, lease.scrollback) }; }
      case "scroll": { const lease = this.lease(frame); if (typeof frame.lines !== "number" || !Number.isFinite(frame.lines)) throw new Error("Invalid scroll request."); lease.scrollback = Math.max(0, Math.min(1000, lease.scrollback - frame.lines)); return { view: this.runtime.getViewAt(lease.sessionId, lease.scrollback), revision: this.revision }; }
      case "writeKey": { this.identity(frame); if (typeof frame.key !== "string") throw new Error("Invalid key."); this.runtime.writeKeyToSession(String(frame.sessionId), frame.key); return {}; }
      case "write": { this.identity(frame); if (typeof frame.input !== "string") throw new Error("Invalid input."); this.runtime.writeToSession(String(frame.sessionId), frame.input); return {}; }
      case "resize": { this.identity(frame); const size = frame.size as PtySize; if (!size || !Number.isInteger(size.columns) || !Number.isInteger(size.rows) || size.columns < 1 || size.rows < 1 || size.columns > 1000 || size.rows > 1000) throw new Error("Invalid terminal dimensions."); this.runtime.resizeSession(String(frame.sessionId), size); this.changed(String(frame.sessionId)); return {}; }
      case "dispose": { const session = this.identity(frame); this.runtime.disposeSession(session.sessionId); this.sessions.delete(session.sessionId); for (const [key, lease] of this.leases) if (lease.sessionId === session.sessionId) { this.leases.delete(key); this.released.set(key, lease.token); } this.changed(session.sessionId); return {}; }
      case "shutdownIfUnused": {
        if (this.runtime.getProcessFacts().some((fact) => fact.status === "running") || this.pendingCreates || this.reservedCreations.size || this.leases.size || this.holds.size) throw new Error("Host is retained by processes, views, pending creates, or handoff holds.");
        this.retiring = true;
        return (async () => {
          try { await this.options.retire?.(); }
          catch (error) { this.retiring = false; throw error; }
          setImmediate(() => this.onShutdown?.()); return {};
        })();
      }
      default: throw new Error("Unsupported host operation.");
    }
  }
}

export async function serveSessionHost(_paths: CraigPaths, record: RuntimeRecord): Promise<void> {
  const host = new SessionHost(record, { retire: async () => {
    const file = path.join(_paths.runtimeDir, "hosts", `${record.instanceId}.json`);
    const current = await readPrivateRecord<RuntimeRecord>(file);
    if (current?.instanceId !== record.instanceId || current.pid !== process.pid) throw new Error("Host ownership changed during retirement.");
    await writePrivateRecord(file, { ...record, retired: true, ready: false });
  } });
  const sockets = new Set<Socket>();
  const server = createServer((socket) => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); host.handleConnection(socket); });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(record.endpoint, resolve); });
  await new Promise<void>((resolve) => { host.onShutdown = () => { for (const socket of sockets) socket.end(() => socket.destroy()); server.close(() => resolve()); }; });
  // No disconnect or signal handler disposes sessions. Host termination is genuine process loss.
}
