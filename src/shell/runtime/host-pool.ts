import { logRuntimeEvent } from "./logging.js";
import { collectRuntimeArtifacts } from "./artifact-retention.js";
import { createHash } from "node:crypto";
import path from "node:path";
import type { CraigPaths } from "../../state/craig-paths.js";
import { RuntimeAcknowledgementUncertainError } from "../../domain/runtime/errors.js";
import { HostClient, type SessionRoute, type LogicalView } from "./host-client.js";
import { newRuntimeRecord, readPrivateRecord, type RuntimeRecord } from "./records.js";
import { launchRuntimeRole, awaitRuntimeRole } from "./bootstrap.js";
import { sessionHostRevision } from "./host-identity.js";
import type { RuntimeFrame } from "./wire.js";
import type { PtySize, PtySessionSpec } from "./session-core.js";

/** Protocol-1 adapter for retained hosts; creation policy stays in control. */
export class HostPool {
  private readonly clients = new Map<string, HostClient>();
  private readonly retentionLogged = new Set<string>();
  private readonly holds = new Set<string>();
  private chain: Promise<unknown> = Promise.resolve();
  // eslint-disable-next-line no-unused-vars
  constructor(readonly paths: CraigPaths, private readonly records: RuntimeRecord[], readonly controller: RuntimeRecord, private readonly changed: (tabIds: string[]) => void) {}
  private get desiredRevision(): string { return this.controller.hostRevision ?? this.records.find((record) => record.artifact === this.controller.artifact)?.hostRevision ?? sessionHostRevision(); }
  get host(): RuntimeRecord { return this.records.find((record) => !record.retired && record.hostRevision === this.desiredRevision) ?? this.records.find((record) => !record.retired) ?? this.controller; }
  hasHost(id: string): boolean { return this.clients.has(id); }
  private serialize<T>(work: () => Promise<T>): Promise<T> { const job = this.chain.then(work); this.chain = job.catch(() => undefined); return job; }
  async connect(): Promise<void> {
    const ids = new Set<string>();
    for (const record of this.records) {
      if (record.schemaVersion !== 1 || record.role !== "host" || record.workspaceId !== this.controller.workspaceId || typeof record.instanceId !== "string" || ids.has(record.instanceId) || (record.retired !== undefined && typeof record.retired !== "boolean")) throw new Error("Unknown or duplicate host discovery identity; routing blocked.");
      ids.add(record.instanceId);
    }
    for (const record of this.records.filter((entry) => !entry.retired)) await this.add(record);
    await this.inventory(); // Reject duplicate authoritative owners before readiness.
  }
  private async add(record: RuntimeRecord): Promise<HostClient> {
    const client = new HostClient(this.paths, record, this.controller, this.changed);
    await client.connect();
    for (const holdId of this.holds) await client.request({ type: "hold", holdId });
    this.clients.set(record.instanceId, client); return client;
  }
  private async current(): Promise<HostClient> {
    const matches = [...this.clients.values()].filter((client) => client.host.hostRevision === this.desiredRevision);
    if (matches.length > 1) throw new Error("Multiple current host generations; creation blocked.");
    if (matches[0]) return matches[0];
    const record = await newRuntimeRecord(this.paths, "host", this.controller.artifact);
    const file = path.join(this.paths.runtimeDir, "hosts", `${record.instanceId}.json`);
    const child = await launchRuntimeRole(this.paths, record, file);
    const ready = await awaitRuntimeRole(file, child);
    if (ready.hostRevision !== this.desiredRevision) throw new Error("New host revision does not match the control artifact.");
    this.records.push(ready); const client = await this.add(ready);
    await client.request({ type: "releaseHold", holdId: `recovery:${this.controller.instanceId}` });
    return client;
  }
  async selectHostForCreation(taskId: string, tabId: string): Promise<RuntimeRecord> {
    return this.serialize(async () => {
      const existing = await this.lookup(taskId, tabId);
      return existing ? this.owner(existing).host : (await this.current()).host;
    });
  }
  private owner(route: Pick<SessionRoute, "hostId">): HostClient {
    const client = this.clients.get(route.hostId);
    if (!client) throw new RuntimeAcknowledgementUncertainError("Session host is retired or unavailable; its incarnation will not be recreated.");
    return client;
  }
  private async committedRetirement(client: HostClient): Promise<boolean> {
    const record = await readPrivateRecord<RuntimeRecord>(path.join(this.paths.runtimeDir, "hosts", `${client.host.instanceId}.json`));
    if (record?.schemaVersion !== 1 || record.role !== "host" || record.retired !== true || record.pid !== client.host.pid || record.instanceId !== client.host.instanceId || record.workspaceId !== client.host.workspaceId) return false;
    client.close(); this.clients.delete(record.instanceId); client.host.retired = true; return true;
  }
  async inventory(): Promise<RuntimeFrame> {
    const inventories = (await Promise.all([...this.clients.values()].map(async (client) => {
      try { return { client, frame: await client.inventory() }; }
      catch (error) { if (await this.committedRetirement(client)) return null; throw error; }
    }))).filter((entry) => entry !== null);
    const sessions = inventories.flatMap(({ client, frame }) => (frame.sessions as SessionRoute[]).map((session) => ({ ...session, hostId: client.host.instanceId })));
    const tabs = sessions.map((session) => session.tabId), ids = sessions.map((session) => session.sessionId);
    if (new Set(tabs).size !== tabs.length || new Set(ids).size !== ids.length) throw new Error("Duplicate session ownership across hosts; routing blocked.");
    const hosts = inventories.map(({ client, frame }) => ({ instanceId: client.host.instanceId, pid: client.host.pid, hostRevision: client.host.hostRevision, sessionCount: (frame.sessions as unknown[]).length, retainedViewCount: frame.leaseCount, pendingCreates: frame.pendingCreates, handoffHoldCount: frame.handoffHoldCount }));
    return { sessions, hosts, activities: inventories.flatMap(({ frame }) => frame.activities as unknown[]), leaseCount: hosts.reduce((sum, host) => sum + Number(host.retainedViewCount), 0) };
  }
  async refreshInventory(): Promise<void> { await Promise.all([...this.clients.values()].map((client) => client.refreshInventory())); }
  async lookup(taskId: string, tabId: string): Promise<SessionRoute | null> {
    const matches = ((await this.inventory()).sessions as SessionRoute[]).filter((session) => session.tabId === tabId);
    if (matches[0] && matches[0].taskId !== taskId) throw new Error("Task/session identity conflict.");
    return matches[0] ?? null;
  }
  async ensure(taskId: string, tabId: string, size: PtySize, spec: PtySessionSpec, reserve?: Pick<SessionRoute, "sessionId" | "creationId"> & { hostId?: string }): Promise<SessionRoute> {
    return this.serialize(async () => {
      const existing = await this.lookup(taskId, tabId);
      const cached = await readPrivateRecord<SessionRoute>(path.join(this.paths.runtimeDir, "sessions", `${createHash("sha256").update(tabId).digest("hex")}.json`));
      const client = existing ? this.owner(existing) : reserve?.hostId ? this.owner({ hostId: reserve.hostId }) : cached ? this.owner(cached) : await this.current();
      return client.ensure(taskId, tabId, size, spec, reserve);
    });
  }
  async request(frame: RuntimeFrame, timeoutMs?: number): Promise<RuntimeFrame> {
    if (typeof frame.hostId === "string") return this.owner({ hostId: frame.hostId }).request(frame, timeoutMs);
    if (frame.type === "hold") this.holds.add(String(frame.holdId));
    if (frame.type === "releaseHold") this.holds.delete(String(frame.holdId));
    if (["hold", "adoptHold", "releaseHold", "shutdownIfUnused"].includes(frame.type ?? "")) {
      const responses = await Promise.all([...this.clients.values()].map(async (client) => {
        try { return await client.request(frame, timeoutMs); }
        catch (error) {
          // Early protocol-1 hosts expose idempotent hold/release but no named
          // adopt operation. Reacquiring the same hold safely adopts it; a lost
          // acknowledgement is never treated as unsupported.
          if (frame.type !== "adoptHold" || !(error instanceof Error) || error.message !== "Unsupported host operation.") throw error;
          return client.request({ ...frame, type: "hold" }, timeoutMs);
        }
      })); return responses[0] ?? {};
    }
    const session = ((await this.inventory()).sessions as SessionRoute[]).find((session) => session.sessionId === frame.sessionId);
    if (!session) throw new Error("An explicit host/session identity is required.");
    return this.owner(session).request(frame, timeoutMs);
  }
  async snapshot(route: SessionRoute, view?: LogicalView) { return this.owner(route).snapshot(route, view); }
  async acquireView(route: SessionRoute, view: LogicalView) { return this.owner(route).acquireView(route, view); }
  async releaseView(route: SessionRoute, view: LogicalView) { return this.owner(route).releaseView(route, view); }
  async scroll(route: SessionRoute, view: LogicalView, lines: number) { return this.owner(route).scroll(route, view, lines); }
  async getActivitySnapshots() { return (await Promise.all([...this.clients.values()].map((client) => client.getActivitySnapshots()))).flat(); }
  async getRunningAgentCapabilities() { return (await Promise.all([...this.clients.values()].map((client) => client.getRunningAgentCapabilities()))).flat(); }
  async hasRunningSession(tabId: string) { return (await Promise.all([...this.clients.values()].map((client) => client.hasRunningSession(tabId)))).some(Boolean); }
  async getStartupBlocker(tabId: string, runner: Parameters<HostClient["getStartupBlocker"]>[1]) {
    const session = ((await this.inventory()).sessions as SessionRoute[]).find((session) => session.tabId === tabId); return session ? this.owner(session).getStartupBlocker(tabId, runner) : null;
  }
  async writeToSession(tabId: string, input: string) {
    const session = ((await this.inventory()).sessions as SessionRoute[]).find((session) => session.tabId === tabId); if (!session) throw new Error("Session unavailable; input was not replayed."); return this.owner(session).writeToSession(tabId, input);
  }
  async disposeSession(tabId: string) {
    const session = ((await this.inventory()).sessions as SessionRoute[]).find((session) => session.tabId === tabId); if (session) await this.owner(session).disposeSession(tabId);
  }
  async retireUnused(): Promise<void> {
    let retired = false;
    await this.serialize(async () => {
      for (const [id, client] of this.clients) {
        if (client.host.hostRevision === this.desiredRevision) continue;
        if (await this.committedRetirement(client)) { retired = true; continue; }
        try {
          if ((await client.inventory()).retirementProtocol !== 1) {
            if (!this.retentionLogged.has(id)) { this.retentionLogged.add(id); await logRuntimeEvent(this.paths, "host.retained", { instanceId: id, reason: "older_retirement_contract" }); }
            continue;
          }
          await client.request({ type: "shutdownIfUnused" });
        } catch {
          // The host persists its atomic retirement decision before replying.
          // Reconcile a lost ack from that identity-bearing durable marker.
          if (!await this.committedRetirement(client)) {
            if (!this.retentionLogged.has(id)) { this.retentionLogged.add(id); await logRuntimeEvent(this.paths, "host.retained", { instanceId: id, reason: "in_use_or_unavailable" }); }
            continue;
          }
        }
        client.close(); this.clients.delete(id); client.host.retired = true; retired = true;
        await logRuntimeEvent(this.paths, "host.retired", { instanceId: id, pid: client.host.pid });
      }
    });
    if (retired) await collectRuntimeArtifacts(this.paths);
  }
  close(): void { for (const client of this.clients.values()) client.close(); }
}
