import { createConnection, type Socket } from "node:net";

import type { PtyActivitySnapshot } from "../domain/agent/index.js";
import type { CraigPaths } from "../state/craig-paths.js";
import { getPtyDaemonEndpoint, PTY_DAEMON_PROTOCOL_VERSION } from "./pty-daemon-protocol.js";

type ActivityRequestInput =
  | { type: "ping" }
  | { type: "setActivityEnabled"; enabled: boolean }
  | { type: "getActivitySnapshots" };

type ActivityResponse =
  | { id: number; ok: true; protocolVersion?: number; activities?: PtyActivitySnapshot[] }
  | { id: number; ok: false; error: string };

type ActivityEvent =
  | { type: "activity"; snapshot: PtyActivitySnapshot }
  | { type: "activityRemoved"; tabId: string };

interface PendingRequest {
  /* eslint-disable no-unused-vars */
  resolve(response: ActivityResponse): void;
  reject(error: Error): void;
  /* eslint-enable no-unused-vars */
}

export interface PtyDaemonActivityClientOptions {
  paths: CraigPaths;
  /* eslint-disable no-unused-vars */
  onActivity?: (snapshot: PtyActivitySnapshot) => void;
  onActivityRemoved?: (tabId: string) => void;
  /* eslint-enable no-unused-vars */
  onDaemonClose?: () => void;
}

export async function tryConnectPtyDaemonActivity(
  options: PtyDaemonActivityClientOptions,
): Promise<PtyDaemonActivityClient | null> {
  let client: PtyDaemonActivityClient | null = null;
  try {
    const socket = await connectToDaemon(getPtyDaemonEndpoint(options.paths).socketPath);
    client = new PtyDaemonActivityClient(socket, options);
    await client.ready();
    return client;
  } catch {
    client?.close();
    return null;
  }
}

export class PtyDaemonActivityClient {
  private readonly pending = new Map<number, PendingRequest>();
  private readonly snapshots = new Map<string, PtyActivitySnapshot>();
  private readonly revisionByTabId = new Map<string, number>();
  private nextRequestId = 1;
  private revision = 0;
  private buffer = "";
  private closed = false;

  constructor(
    private readonly socket: Socket,
    // eslint-disable-next-line no-unused-vars
    private readonly options: PtyDaemonActivityClientOptions,
  ) {
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => this.handleData(String(chunk)));
    socket.on("error", (error) => this.rejectAll(error instanceof Error ? error : new Error(String(error))));
    socket.on("close", () => this.handleClose());
  }

  async ready(): Promise<void> {
    const ping = await this.send({ type: "ping" });
    if (ping.protocolVersion !== PTY_DAEMON_PROTOCOL_VERSION) {
      throw new Error("Craig PTY daemon protocol mismatch.");
    }
    await this.send({ type: "setActivityEnabled", enabled: true });
    const baselineRevision = this.revision;
    const response = await this.send({ type: "getActivitySnapshots" });
    this.replaceSnapshots(response.activities ?? [], baselineRevision);
  }

  getSnapshots(): PtyActivitySnapshot[] {
    return [...this.snapshots.values()];
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.socket.end();
    this.rejectAll(new Error("Craig PTY daemon activity connection closed."));
  }

  private async send(request: ActivityRequestInput): Promise<Extract<ActivityResponse, { ok: true }>> {
    if (this.closed || this.socket.destroyed) {
      throw new Error("Craig PTY daemon activity connection is closed.");
    }
    const id = this.nextRequestId++;
    const response = new Promise<ActivityResponse>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    this.socket.write(`${JSON.stringify({ ...request, id })}\n`);
    const resolved = await response;
    if (!resolved.ok) throw new Error(resolved.error);
    return resolved;
  }

  private handleData(chunk: string): void {
    this.buffer += chunk;
    let newlineIndex = this.buffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = this.buffer.slice(0, newlineIndex);
      this.buffer = this.buffer.slice(newlineIndex + 1);
      this.handleMessage(line);
      newlineIndex = this.buffer.indexOf("\n");
    }
  }

  private handleMessage(line: string): void {
    if (line.trim().length === 0) return;
    let message: ActivityResponse | ActivityEvent;
    try {
      message = JSON.parse(line) as ActivityResponse | ActivityEvent;
    } catch {
      return;
    }
    if ("id" in message) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      pending.resolve(message);
      return;
    }
    if (message.type === "activity") {
      this.recordSnapshot(message.snapshot);
      this.options.onActivity?.(message.snapshot);
    } else if (message.type === "activityRemoved") {
      this.removeSnapshot(message.tabId);
      this.options.onActivityRemoved?.(message.tabId);
    }
  }

  private replaceSnapshots(snapshots: PtyActivitySnapshot[], baselineRevision: number): void {
    const newer = new Map<string, PtyActivitySnapshot | null>();
    for (const [tabId, revision] of this.revisionByTabId) {
      if (revision > baselineRevision) newer.set(tabId, this.snapshots.get(tabId) ?? null);
    }
    this.snapshots.clear();
    for (const snapshot of snapshots) this.snapshots.set(snapshot.tabId, snapshot);
    for (const [tabId, snapshot] of newer) {
      if (snapshot) this.snapshots.set(tabId, snapshot);
      else this.snapshots.delete(tabId);
    }
  }

  private recordSnapshot(snapshot: PtyActivitySnapshot): void {
    this.revision += 1;
    this.revisionByTabId.set(snapshot.tabId, this.revision);
    this.snapshots.set(snapshot.tabId, snapshot);
  }

  private removeSnapshot(tabId: string): void {
    this.revision += 1;
    this.revisionByTabId.set(tabId, this.revision);
    this.snapshots.delete(tabId);
  }

  private handleClose(): void {
    if (this.closed) return;
    this.closed = true;
    const error = new Error("Craig PTY daemon connection closed.");
    this.rejectAll(error);
    for (const snapshot of this.snapshots.values()) {
      if (snapshot.sessionState !== "running") continue;
      const failed = { ...snapshot, sessionState: "failed" as const, lastActivityAt: Date.now(), error: error.message };
      this.recordSnapshot(failed);
      this.options.onActivity?.(failed);
    }
    this.options.onDaemonClose?.();
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}

function connectToDaemon(socketPath: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });
}
