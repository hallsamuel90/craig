import { createGhosttyEmulator } from "./terminal/ghostty/emulator.js";
import { createTerminalEmulator } from "./terminal/terminal-emulator.js";
import { logRuntimeEvent } from "./logging.js";
import { RuntimeTransport } from "./wire.js";
import { runtimeMutationContext } from "./mutation-context.js";
import { RuntimeAcknowledgementUncertainError, RuntimeUpgradeRetryError } from "../../domain/runtime/errors.js";
import { requireWorkspaceRuntimeCapabilities } from "./discovery.js";
import path from "node:path";
import { readPrivateRecord, writePrivateRecord } from "./records.js";
import { randomUUID } from "node:crypto";
import { shutdownSplitRuntime } from "./bootstrap.js";
import { getClientRuntimeEndpoint } from "./endpoint.js";
import { createServer, createConnection, type Socket, type Server } from "node:net";
import { lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";

import type { CraigPaths } from "../../state/craig-paths.js";
import type { TerminalViewState } from "./terminal/types.js";
import type { TerminalScreenRow } from "./terminal/terminal-emulator.js";
import type { PtyActivitySnapshot } from "../../domain/agent/index.js";
import { configService } from "../../domain/config/index.js";
import { errorService } from "../../domain/error/index.js";
import { listFuryRuns, listPromptCommands, refreshAgentCapability } from "../../domain/orchestration/index.js";
import {
  getPtyDaemonEndpoint,
  PTY_DAEMON_PROTOCOL_VERSION,
} from "../pty-daemon-protocol.js";
import { ensureRuntimeRunning } from "../runtime/start.js";
import { acquireRuntimeLock, cleanupDeadEndpoint } from "../runtime/ownership.js";
import { resolveRuntimeCompatibility } from "../runtime/compatibility.js";
import { runtimeIdentity } from "../runtime/identity.js";
import type { RuntimeHello } from "../../domain/runtime/types.js";
import { OrchestrationSupervisor } from "../orchestration-supervisor.js";
import { reconcileEvents } from "../event-reconciliation.js";
import {
  PullRequestSyncSupervisor,
  type PullRequestSyncSupervisorOptions,
} from "../pull-request-sync-supervisor.js";
import type { GitHubPollView } from "../github-poll-coordinator.js";
import {
  PtyRuntime,
  type PtyRuntimeOptions,
  type PtySessionSpec,
  type PtySize,
} from "./local-runtime.js";

const DAEMON_PROTOCOL_VERSION = PTY_DAEMON_PROTOCOL_VERSION;
const INCREMENTAL_VIEW_UPDATE_INTERVAL_MS = 16;
const ACTIVITY_UPDATE_INTERVAL_MS = 250;

type DaemonRequest =
  | { id: number; type: "acknowledgeView"; tabId: string; viewId: string; viewToken: string }
  | { id: number; type: "registerViewClient"; clientId: string; proof: string }
  | { id: number; type: "ping" }
  | { id: number; type: "ensureSession"; taskId: string; tabId: string; size: PtySize; spec: PtySessionSpec }
  | { id: number; type: "hydrateSession"; tabId: string }
  | { id: number; type: "attachExisting"; tabId: string }
  | { id: number; type: "pruneStale"; keepTabIds: string[] }
  | { id: number; type: "write"; input: string }
  | { id: number; type: "writeKey"; key: string }
  | { id: number; type: "scrollViewport"; lines: number }
  | { id: number; type: "resize"; size: PtySize }
  | { id: number; type: "detach" }
  | { id: number; type: "disposeSession"; tabId: string }
  | { id: number; type: "setViewUpdateMode"; mode: "incremental" }
  | { id: number; type: "setActivityEnabled"; enabled: boolean }
  | { id: number; type: "subscribeView"; tabId: string | null }
  | { id: number; type: "getViewState"; tabId: string | null }
  | { id: number; type: "getActivitySnapshots" }
  | { id: number; type: "setPullRequestPollView"; view: GitHubPollView }
  | { id: number; type: "subscribeNavigation" }
  | { id: number; type: "openFile"; path: string }
  | { id: number; type: "wakeOrchestration" }
  | { id: number; type: "drainIfEmpty" }
  | { id: number; type: "shutdown" };

type DaemonResponse =
  | { id: number; ok: true; protocolVersion?: number; sessionCount?: number; ghosttyTerminal?: boolean; viewId?: string; viewToken?: string; sessionId?: string; capabilities?: RuntimeHello["capabilities"]; buildId?: string; craigVersion?: string; lifecycle?: "ready" | "draining"; view?: TerminalViewState; activities?: PtyActivitySnapshot[]; deliveredCount?: number }
  | { id: number; ok: false; error: string; uncertain?: boolean; retryable?: boolean };
type DaemonOkResponse = Extract<DaemonResponse, { ok: true }>;

interface TerminalViewPatch {
  status: TerminalViewState["status"];
  error: string | null;
  scrolledBack: boolean;
  rowCount: number;
  rows: Array<{ index: number; row: TerminalScreenRow }>;
}

type DaemonEvent =
  | { type: "lifecycle"; state: "ready" | "draining" }
  | { type: "update"; tabId: string; view: TerminalViewState }
  | { type: "update"; tabId: string; patch: TerminalViewPatch }
  | { type: "activity"; snapshot: PtyActivitySnapshot }
  | { type: "activityRemoved"; tabId: string }
  | { type: "openFile"; path: string }
  | { type: "tasksChanged"; taskIds: string[] };
type DaemonMessage = DaemonResponse | DaemonEvent;

interface ClientViewSubscription {
  activityEnabled: boolean;
  tabId: string | null;
  view: TerminalViewState | null;
  rowKeys: string[];
  pullRequestPollView: GitHubPollView;
  navigationEnabled: boolean;
}

/* eslint-disable no-unused-vars */
interface PendingRequest {
  resolve: (response: DaemonResponse) => void;
  reject: (error: Error) => void;
}

export interface DaemonPtyRuntimeOptions extends PtyRuntimeOptions {
  paths: CraigPaths;
  spawnDaemon?: (workspaceRoot: string) => void;
  viewClient?: { clientId: string; proof: string };
  activityEnabled?: boolean;
  onLifecycle?: (message: string | null) => void;
  onTasksChanged?: (taskIds: string[]) => void;
  onOpenFile?: (path: string) => void;
}

export interface PtyDaemonServerOptions extends Partial<PtyRuntimeOptions> {
  pullRequestSync?: false | PullRequestSyncSupervisorOptions;
}
/* eslint-enable no-unused-vars */

export async function createDaemonPtyRuntime(options: DaemonPtyRuntimeOptions): Promise<DaemonPtyRuntimeClient> {
  await ensureRuntimeRunning(options.paths, options.spawnDaemon);
  const endpoint = getClientRuntimeEndpoint(options.paths);
  const socket = await connectToDaemon(endpoint.socketPath);
  const client = new DaemonPtyRuntimeClient(socket, options);
  try { await client.ready(); return client; }
  catch (error) { client.disposeAll(); throw error; }
}

export async function servePtyDaemon(paths: CraigPaths, options: PtyDaemonServerOptions = {}): Promise<void> {
  const endpoint = getPtyDaemonEndpoint(paths);
  await mkdir(paths.runtimeDir, { recursive: true });
  const releaseOwner = await acquireRuntimeLock(paths, "daemon-owner");
  try { await cleanupDeadEndpoint(paths); } catch (error) { await releaseOwner(); throw error; }
  const daemon = new PtyDaemonServer(paths, options);
  const server = createServer((socket) => daemon.handleConnection(socket));
  let ownedSocket: Awaited<ReturnType<typeof lstat>> | null = null;
  let ownedPid: Awaited<ReturnType<typeof lstat>> | null = null;
  try {
    await listen(server, endpoint.socketPath);
    ownedSocket = await lstat(endpoint.socketPath);
    await daemon.start();
    await writeFile(endpoint.pidPath, String(process.pid), { encoding: "utf8", mode: 0o600 });
    ownedPid = await lstat(endpoint.pidPath);
    await errorService.appendLogBestEffort(paths, {
      level: "info",
      component: "daemon",
      event: "started",
      message: `PTY daemon started with protocol ${DAEMON_PROTOCOL_VERSION}.`,
      details: { pid: process.pid, protocolVersion: DAEMON_PROTOCOL_VERSION },
    });

    await new Promise<void>((resolve) => {
      let closing = false;
      const close = () => {
        if (closing) return;
        closing = true;
        daemon.closeClients();
        server.close(() => {
          process.removeListener("SIGTERM", close);
          process.removeListener("SIGINT", close);
          resolve();
        });
      };

      daemon.onShutdown = close;
      process.once("SIGTERM", close);
      process.once("SIGINT", close);
    });
  } catch (error) {
    await errorService.appendLogBestEffort(paths, {
      level: "error",
      component: "daemon",
      event: "failed",
      message: error instanceof Error ? error.message : String(error),
      details: { pid: process.pid },
    });
    throw error;
  } finally {
    daemon.closeClients();
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    await errorService.appendLogBestEffort(paths, {
      level: "info",
      component: "daemon",
      event: "stopped",
      message: "PTY daemon stopped and disposed its remaining sessions.",
      details: { pid: process.pid, remainingSessionCount: daemon.sessionCount() },
    });
    daemon.onShutdown = null;
    const currentSocket = await lstat(endpoint.socketPath).catch(() => null);
    const currentPid = await lstat(endpoint.pidPath).catch(() => null);
    if (ownedPid && currentPid?.ino === ownedPid.ino && currentPid.dev === ownedPid.dev && await readFile(endpoint.pidPath, "utf8").catch(() => null) === String(process.pid)) {
      if (ownedSocket && currentSocket?.ino === ownedSocket.ino && currentSocket.dev === ownedSocket.dev) await rm(endpoint.socketPath);
      await rm(endpoint.pidPath, { force: true });
    }
    try { await daemon.stop(); daemon.disposeAll(); }
    finally { await releaseOwner(); }
  }
}

export async function requestDaemonShutdown(paths: CraigPaths): Promise<boolean> {
  if (await shutdownSplitRuntime(paths)) return true;
  const endpoint = getPtyDaemonEndpoint(paths);
  if (!(await canConnect(endpoint.socketPath))) {
    return false;
  }

  await shutdownDaemonSocket(endpoint.socketPath);
  return true;
}

export class DaemonPtyRuntimeClient {
  managesPullRequestSync = true;
  get supportsTaskCreateAdmission(): boolean { return this.splitRuntime; }
  upgradePendingMessage: string | null = null;
  private nextRequestId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly viewRevisionByTab = new Map<string, number>();
  private viewPersistence: Promise<void> = Promise.resolve();
  private readonly viewCache = new Map<string, TerminalViewState>();
  private readonly activityCache = new Map<string, PtyActivitySnapshot>();
  private readonly activityRevisionByTabId = new Map<string, number>();
  private activityRevision = 0;
  private attachedTabId: string | null = null;
  private viewedTabId: string | null = null;
  private subscribedTabId: string | null = null;
  private activityEnabled: boolean;
  private pullRequestPollView: GitHubPollView = { selectedTaskId: null, reviewVisible: false };
  /* eslint-disable-next-line no-unused-vars */
  private tasksChangedHandler: ((taskIds: string[]) => void) | undefined;
  /* eslint-disable-next-line no-unused-vars */
  private openFileHandler: ((path: string) => void) | undefined;
  private buffer = "";
  private closed = false;
  private disposed = false;
  private reconnecting = false;
  private controlDraining = false;
  private inputUncertain = false;
  connectionMessage: string | null = null;
  private protocolVersion = DAEMON_PROTOCOL_VERSION;
  private viewClient: { clientId: string; proof: string } | undefined;
  private splitRuntime = false;
  private readonly options: DaemonPtyRuntimeOptions;

  constructor(private socket: Socket, options: DaemonPtyRuntimeOptions) {
    this.options = options;
    this.activityEnabled = options.activityEnabled ?? false;
    this.tasksChangedHandler = options.onTasksChanged;
    this.openFileHandler = options.onOpenFile;
    this.bindSocket(socket);
  }
  private lifecycle(message: string | null): void { this.connectionMessage = message; this.options.onLifecycle?.(message); }
  private bindSocket(socket: Socket): void {
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => { if (this.socket === socket) this.handleData(String(chunk)); });
    socket.on("error", (error) => { if (this.socket === socket) this.rejectAll(this.splitRuntime ? new RuntimeAcknowledgementUncertainError("Control transport failed; existing processes are retained. Do not replay input.") : error); });
    socket.on("close", () => {
      if (this.socket !== socket || this.disposed || this.closed) return;
      this.closed = true;
      this.rejectAll(this.splitRuntime ? new RuntimeAcknowledgementUncertainError("Control disconnected; mutation acknowledgements are uncertain. Existing sessions are retained.") : new Error("Craig PTY daemon connection closed."));
      if (!this.splitRuntime) this.failRunningActivities("Craig PTY daemon connection closed.");
      else if (!this.reconnecting) void this.reconnect();
    });
  }
  private async reconnect(): Promise<void> {
    this.reconnecting = true;
    this.lifecycle("Reconnecting to Craig control… Input paused; agents continue running.");
    while (!this.disposed) {
      let next: Socket | undefined;
      try {
        next = await connectToDaemon(getClientRuntimeEndpoint(this.options.paths).socketPath);
        if (this.disposed) { next.destroy(); break; }
        this.socket = next; this.closed = false; this.buffer = ""; this.bindSocket(next);
        await this.ready();
        // Only reads/subscriptions are retried. Never call ensure or replay input.
        for (const tabId of this.viewCache.keys()) {
          const response = await this.send({ type: "hydrateSession", tabId });
          if (response.view) this.viewCache.set(tabId, response.view);
        }
        if (this.attachedTabId) await this.send({ type: "attachExisting", tabId: this.attachedTabId });
        this.subscribedTabId = null;
        const response = await this.send({ type: "subscribeView", tabId: this.viewedTabId });
        if (this.viewedTabId && response.view) this.viewCache.set(this.viewedTabId, response.view);
        this.subscribedTabId = this.viewedTabId;
        await this.send({ type: "setPullRequestPollView", view: this.pullRequestPollView });
        this.reconnecting = false;
        await logRuntimeEvent(this.options.paths, "client.reconnected", { protocolVersion: this.protocolVersion });
        this.lifecycle(this.inputUncertain ? "Reconnected. Previous input acknowledgement is uncertain; do not replay it." : this.upgradePendingMessage);
        if (this.viewedTabId) this.notifyFullUpdate(this.viewedTabId);
        return;
      } catch {
        this.closed = true; next?.destroy();
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    this.reconnecting = false;
  }

  private supportsGhostty = false;

  async ready(): Promise<void> {
    const response = await this.send({ type: "ping" });
    await requireWorkspaceRuntimeCapabilities(this.options.paths, response, ["terminal", "activity"]);
    this.upgradePendingMessage = resolveRuntimeCompatibility(response, [], runtimeIdentity()).reason;
    this.managesPullRequestSync = resolveRuntimeCompatibility(response, ["pullRequestPolling"]).compatible;
    if (response.capabilities?.includes("splitRuntime")) {
      this.splitRuntime = true;
      const viewClient = this.viewClient ?? this.options.viewClient ?? { clientId: randomUUID(), proof: randomUUID() };
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(viewClient.clientId)) throw new Error("Invalid persisted view-client id.");
      this.viewClient = viewClient;
      const file = path.join(this.options.paths.runtimeDir, "view-clients", `${viewClient.clientId}.json`);
      const previous = await readPrivateRecord<{ proof: string; leases: Record<string, unknown> }>(file);
      if (previous && previous.proof !== viewClient.proof) throw new Error("View-client identity is already owned.");
      await writePrivateRecord(file, { ...viewClient, ownerPid: process.pid, leases: previous?.leases ?? {} });
      await this.send({ type: "registerViewClient", ...viewClient });
    }
    if (response.lifecycle === "draining") throw new Error("Control is updating; reconnect after readiness.");
    this.controlDraining = false;
    this.supportsGhostty = response.capabilities?.includes("ghosttyTerminal") === true || response.ghosttyTerminal === true;
    this.protocolVersion = response.protocolVersion!;
    await logRuntimeEvent(this.options.paths, "runtime.discovered", { protocolVersion: this.protocolVersion, buildId: response.buildId });
    if (this.protocolVersion <= 8) {
      await this.send({ type: "setViewUpdateMode", mode: "incremental" });
    }
    await this.send({ type: "setActivityEnabled", enabled: this.activityEnabled });
    if (resolveRuntimeCompatibility(response, ["navigation"]).compatible) await this.send({ type: "subscribeNavigation" });
    if (this.activityEnabled) {
      await this.refreshActivitySnapshots();
    }
  }

  async ensureSession(taskId: string, tabId: string, size: PtySize): Promise<TerminalViewState> {
    if (!this.supportsGhostty && (await configService.load(this.options.paths)).previews?.ghosttyTerminal) {
      const existing = await this.send({ type: "getViewState", tabId });
      if (existing.view?.status !== "running") throw new Error("Ghostty needs a newer PTY daemon. Disable the preview to keep using this daemon, or restart it after closing existing sessions.");
    }
    const response = await this.send({
      type: "ensureSession",
      taskId,
      tabId,
      size,
      spec: this.options.resolveSessionSpec?.(taskId, tabId) ?? { cwd: this.options.workspaceRoot, command: [] },
    });
    this.attachedTabId = tabId;
    this.viewedTabId = tabId;
    this.subscribedTabId = tabId;
    const view = response.view ?? { status: "idle", rows: [], error: null };
    this.viewCache.set(tabId, view);
    return view;
  }

  async hydrateSessions(tabIds: string[]): Promise<void> {
    for (const tabId of tabIds) {
      try {
        const response = await this.send({ type: "hydrateSession", tabId });
        if (response.view) {
          this.viewCache.set(tabId, response.view);
          if (response.view.status === "idle") {
            void errorService.appendLogBestEffort(this.options.paths, {
              level: "debug",
              component: "pty",
              event: "hydration.missing",
              message: "No live PTY session was found for the persisted tab.",
              tabId,
            });
          }
        }
      } catch (error) {
        if (this.splitRuntime) continue;
        const message = error instanceof Error ? error.message : String(error);
        this.viewCache.set(tabId, { status: "failed", rows: [], error: message });
      }
    }
    if (this.activityEnabled) {
      await this.refreshActivitySnapshots();
    }
  }

  async pruneStale(_keepTabIds: string[]): Promise<void> {
    void _keepTabIds;
    // Never send destructive inventory reconciliation to legacy runtimes.
  }

  write(input: string): void {
    this.sendInput({ type: "write", input });
  }

  writeKey(key: string): void {
    this.sendInput({ type: "writeKey", key });
  }

  private sendInput(request: { type: "write"; input: string } | { type: "writeKey"; key: string }): void {
    if (this.splitRuntime && (this.closed || this.reconnecting || this.controlDraining)) { this.lifecycle("Craig control is updating or reconnecting… Input paused; this key was not sent."); return; }
    void this.send(request).catch((error: unknown) => {
      this.inputUncertain = error instanceof RuntimeAcknowledgementUncertainError;
      this.lifecycle(this.inputUncertain ? "Input acknowledgement is uncertain; do not replay it." : error instanceof Error ? error.message : "Input was rejected.");
    });
  }

  scrollViewport(lines: number): void {
    const tabId = this.attachedTabId;
    void this.send({ type: "scrollViewport", lines }).then((response) => {
      if (tabId && response.view) {
        this.viewCache.set(tabId, response.view);
        this.notifyFullUpdate(tabId);
      }
    }).catch(() => undefined);
  }

  resize(size: PtySize): void {
    const tabId = this.attachedTabId;
    void this.send({ type: "resize", size }).then((response) => {
      if (tabId && response.view) {
        this.viewCache.set(tabId, response.view);
        this.notifyFullUpdate(tabId);
      }
    }).catch(() => undefined);
  }

  detach(): void {
    this.attachedTabId = null;
    void this.send({ type: "detach" }).catch(() => undefined);
  }

  setViewedTab(tabId: string | null): void {
    if (this.closed) {
      return;
    }

    this.viewedTabId = tabId;
    this.subscribeToView(tabId);
  }

  setActivityEnabled(enabled: boolean): void {
    if (this.closed || this.activityEnabled === enabled) {
      return;
    }
    this.activityEnabled = enabled;
    if (!enabled) {
      for (const tabId of [...this.activityCache.keys()]) {
        this.removeCachedActivity(tabId);
      }
      void this.send({ type: "setActivityEnabled", enabled }).catch(() => undefined);
      return;
    }
    void this.send({ type: "setActivityEnabled", enabled })
      .then(() => this.refreshActivitySnapshots(true))
      .catch(() => undefined);
  }

  setPullRequestPollView(view: GitHubPollView): void {
    if (!this.managesPullRequestSync) return;
    if (
      this.closed ||
      (this.pullRequestPollView.selectedTaskId === view.selectedTaskId &&
        this.pullRequestPollView.reviewVisible === view.reviewVisible)
    ) {
      return;
    }
    this.pullRequestPollView = view;
    void this.send({ type: "setPullRequestPollView", view }).catch(() => undefined);
  }

  /* eslint-disable-next-line no-unused-vars */
  setTasksChangedHandler(handler: (taskIds: string[]) => void): void {
    this.tasksChangedHandler = handler;
  }

  /* eslint-disable-next-line no-unused-vars */
  setOpenFileHandler(handler: (path: string) => void): void {
    this.openFileHandler = handler;
  }

  disposeSession(tabId: string): void {
    void this.disposeSessionConfirmed(tabId).catch((error: unknown) => this.lifecycle(error instanceof Error ? error.message : "Session closure was not acknowledged; inspect before retrying."));
  }
  async disposeSessionConfirmed(tabId: string): Promise<void> {
    if (this.splitRuntime) {
      // A domain close can outlive this foreground socket. Its admission token
      // authorizes the one confirmed disposal on the current control service.
      const transport = await RuntimeTransport.connect(getClientRuntimeEndpoint(this.options.paths).socketPath);
      const admissionToken = runtimeMutationContext.getStore();
      try {
        const hello = await transport.request({ type: "ping", admissionToken });
        await requireWorkspaceRuntimeCapabilities(this.options.paths, hello as RuntimeHello, ["terminal"]);
        await transport.request({ type: "disposeSession", tabId, admissionToken });
      } finally { transport.close(); }
    } else await this.send({ type: "disposeSession", tabId });
    this.viewCache.delete(tabId);
    this.removeCachedActivity(tabId);
    if (this.attachedTabId === tabId) this.attachedTabId = null;
  }

  disposeAll(): void {
    this.disposed = true;
    this.attachedTabId = null;
    if (this.closed) {
      return;
    }

    this.socket.end();
    this.closed = true;
    this.rejectAll(new RuntimeAcknowledgementUncertainError("Client closed; outstanding mutation outcomes are uncertain."));
  }

  getViewState(tabId: string | null): TerminalViewState {
    if (!tabId) {
      return { status: "idle", rows: [], error: null, scrolledBack: false };
    }

    return this.viewCache.get(tabId) ?? { status: "idle", rows: [], error: null, scrolledBack: false };
  }

  getActivitySnapshots(): PtyActivitySnapshot[] {
    return [...this.activityCache.values()];
  }

  async requestShutdown(): Promise<void> {
    await this.send({ type: "shutdown" });
  }

  private async send(request: Omit<DaemonRequest, "id"> & Record<string, unknown>): Promise<DaemonOkResponse> {
    if (this.closed || this.socket.destroyed) {
      if (this.splitRuntime) throw new RuntimeAcknowledgementUncertainError("Control is unavailable; reopen Craig to reattach to the existing session.");
      throw new Error("Craig PTY daemon connection is closed.");
    }

    const tabId = typeof request.tabId === "string" ? request.tabId : ["resize", "scrollViewport"].includes(request.type) ? this.attachedTabId : null;
    let responseRevision = tabId ? this.viewRevisionByTab.get(tabId) ?? 0 : 0;
    const id = this.nextRequestId;
    this.nextRequestId += 1;
    const payload = { ...request, id, ...(runtimeMutationContext.getStore() ? { admissionToken: runtimeMutationContext.getStore() } : {}) } as DaemonRequest;
    const response = new Promise<DaemonResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RuntimeAcknowledgementUncertainError("Control acknowledgement timed out; do not replay input."));
        this.socket.destroy();
      }, 5000);
      this.pending.set(id, { resolve: (value) => {
        clearTimeout(timer);
        // Events received before this reply cannot supersede its snapshot (in
        // particular an explicit scroll). Only later events win while a view
        // ownership token is being durably persisted.
        responseRevision = tabId ? this.viewRevisionByTab.get(tabId) ?? 0 : 0;
        resolve(value);
      }, reject: (error) => { clearTimeout(timer); reject(error); } });
    });
    this.socket.write(`${JSON.stringify(payload)}\n`);
    const resolved = await response;
    if (!resolved.ok) {
      if (resolved.uncertain) throw new RuntimeAcknowledgementUncertainError(resolved.error);
      if (resolved.retryable) throw new RuntimeUpgradeRetryError(resolved.error);
      throw new Error(resolved.error);
    }
    if (this.viewClient && typeof request.tabId === "string" && resolved.viewId && resolved.viewToken) {
      const viewClient = this.viewClient;
      const save = async () => {
        const file = path.join(this.options.paths.runtimeDir, "view-clients", `${viewClient.clientId}.json`);
        const previous = await readPrivateRecord<{ leases: Record<string, unknown> }>(file);
        await writePrivateRecord(file, { ...viewClient, ownerPid: process.pid, leases: { ...previous?.leases, [String(request.tabId)]: { viewId: resolved.viewId, viewToken: resolved.viewToken, sessionId: resolved.sessionId } } });
        await this.send({ type: "acknowledgeView", tabId: String(request.tabId), viewId: resolved.viewId!, viewToken: resolved.viewToken! });
      };
      this.viewPersistence = this.viewPersistence.then(save, save);
      await this.viewPersistence;
    }
    if (tabId && resolved.view && (this.viewRevisionByTab.get(tabId) ?? 0) > responseRevision) resolved.view = this.viewCache.get(tabId) ?? resolved.view;
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
    if (line.trim().length === 0) {
      return;
    }

    let message: DaemonMessage;
    try {
      message = JSON.parse(line) as DaemonMessage;
    } catch {
      return;
    }

    if ("id" in message) {
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }

      this.pending.delete(message.id);
      pending.resolve(message);
      return;
    }

    if (message.type === "lifecycle") {
      this.controlDraining = message.state === "draining";
      this.lifecycle(this.controlDraining ? "Craig control is updating… Input paused; agents continue running." : this.inputUncertain ? "Previous input acknowledgement is uncertain; do not replay it." : this.upgradePendingMessage);
      return;
    }
    if (message.type === "update") {
      this.viewRevisionByTab.set(message.tabId, (this.viewRevisionByTab.get(message.tabId) ?? 0) + 1);
      if ("view" in message) {
        this.viewCache.set(message.tabId, message.view);
        if (this.viewedTabId === message.tabId) this.notifyFullUpdate(message.tabId);
        return;
      }
      const current = this.viewCache.get(message.tabId) ?? { status: "idle" as const, rows: [], error: null, scrolledBack: false };
      const metadataChanged = hasPatchMetadataChanged(current, message.patch);
      const rows = current.rows.slice(0, message.patch.rowCount);
      for (const changed of message.patch.rows) {
        rows[changed.index] = changed.row;
      }
      this.viewCache.set(message.tabId, {
        status: message.patch.status,
        rows,
        error: message.patch.error,
        scrolledBack: message.patch.scrolledBack,
      });
      if (this.viewedTabId === message.tabId) {
        this.options.onUpdate?.(metadataChanged
          ? { tabId: message.tabId, kind: "full" }
          : { tabId: message.tabId, kind: "rows", rowIndices: message.patch.rows.map((row) => row.index) });
      }
    }
    if (message.type === "activity") {
      this.recordCachedActivity(message.snapshot);
      this.options.onActivity?.(message.snapshot);
    }
    if (message.type === "activityRemoved") {
      this.removeCachedActivity(message.tabId);
    }
    if (message.type === "tasksChanged") {
      this.tasksChangedHandler?.(message.taskIds);
    }
    if (message.type === "openFile") {
      this.openFileHandler?.(message.path);
    }
  }

  private subscribeToView(tabId: string | null): void {
    if (this.closed || this.subscribedTabId === tabId) {
      return;
    }

    this.subscribedTabId = tabId;
    void this.send({ type: "subscribeView", tabId }).then((response) => {
      if (tabId && response.view) {
        this.viewCache.set(tabId, response.view);
      }
      if (this.viewedTabId === tabId && this.subscribedTabId === tabId) {
        this.notifyFullUpdate(tabId);
      }
    }).catch(() => {
      if (this.subscribedTabId === tabId) {
        this.subscribedTabId = null;
      }
    });
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }

  private notifyFullUpdate(tabId: string | null): void {
    if (tabId) {
      this.options.onUpdate?.({ tabId, kind: "full" });
    }
  }

  private replaceActivityCache(snapshots: PtyActivitySnapshot[], baselineRevision: number): void {
    const newerActivity = new Map<string, PtyActivitySnapshot | null>();
    for (const [tabId, revision] of this.activityRevisionByTabId) {
      if (revision > baselineRevision) {
        newerActivity.set(tabId, this.activityCache.get(tabId) ?? null);
      }
    }
    this.activityCache.clear();
    for (const snapshot of snapshots) {
      this.activityCache.set(snapshot.tabId, snapshot);
    }
    for (const [tabId, snapshot] of newerActivity) {
      if (snapshot) {
        this.activityCache.set(tabId, snapshot);
      } else {
        this.activityCache.delete(tabId);
      }
    }
  }

  private async refreshActivitySnapshots(notify = false): Promise<void> {
    const activityRevision = this.activityRevision;
    const activityResponse = await this.send({ type: "getActivitySnapshots" });
    this.replaceActivityCache(activityResponse.activities ?? [], activityRevision);
    if (notify) {
      for (const snapshot of this.activityCache.values()) {
        this.options.onActivity?.(snapshot);
      }
    }
  }

  private recordCachedActivity(snapshot: PtyActivitySnapshot): void {
    this.activityRevision += 1;
    this.activityRevisionByTabId.set(snapshot.tabId, this.activityRevision);
    this.activityCache.set(snapshot.tabId, snapshot);
  }

  private removeCachedActivity(tabId: string): void {
    this.activityRevision += 1;
    this.activityRevisionByTabId.set(tabId, this.activityRevision);
    this.activityCache.delete(tabId);
    this.options.onActivityRemoved?.(tabId);
  }

  private failRunningActivities(message: string): void {
    for (const snapshot of this.activityCache.values()) {
      if (snapshot.sessionState !== "running") {
        continue;
      }
      const failed: PtyActivitySnapshot = {
        ...snapshot,
        sessionState: "failed",
        lastActivityAt: Date.now(),
        error: message,
      };
      this.recordCachedActivity(failed);
      this.options.onActivity?.(failed);
    }
  }
}

class PtyDaemonServer {
  private readonly emulatorFactoryOverride: PtyRuntimeOptions["createEmulator"];
  private readonly identity = runtimeIdentity();
  onShutdown: (() => void) | null = null;
  private readonly clients = new Set<Socket>();
  private readonly subscriptions = new Map<Socket, ClientViewSubscription>();
  private readonly updateTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly activityTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly pendingActivities = new Map<string, PtyActivitySnapshot>();
  private readonly runtime: PtyRuntime;
  private readonly paths: CraigPaths;
  private orchestrationSupervisor: OrchestrationSupervisor | null = null;
  private orchestrationSupervisorStartup: Promise<OrchestrationSupervisor> | null = null;
  private pullRequestSyncSupervisor: PullRequestSyncSupervisor | null = null;
  private pullRequestEventReconciliationEnabled = false;
  private readonly pullRequestSyncOptions: false | PullRequestSyncSupervisorOptions | undefined;
  private attachedTabId: string | null = null;

  constructor(paths: CraigPaths, options: PtyDaemonServerOptions) {
    this.emulatorFactoryOverride = options.createEmulator;
    this.paths = paths;
    this.pullRequestSyncOptions = options.pullRequestSync;
    const runtimeOptions = { ...options };
    delete runtimeOptions.pullRequestSync;
    this.runtime = new PtyRuntime({
      ...runtimeOptions,
      workspaceRoot: paths.workspaceRoot,
      activityEnabled: false,
      onUpdate: (invalidation) => this.handleRuntimeUpdate(invalidation.tabId),
      onActivity: (snapshot) => this.handleActivityUpdate(snapshot),
      onActivityRemoved: (tabId) => this.handleActivityRemoved(tabId),
    });
  }

  async start(): Promise<void> {
    const config = await configService.load(this.paths);
    if (this.pullRequestSyncOptions !== false) {
      const configuredOptions = this.pullRequestSyncOptions ?? {};
      const reconcilePullRequestEvents = configuredOptions.reconcileEvents === false
        ? false
        : configuredOptions.reconcileEvents ?? (() => reconcileEvents(this.paths, {
            agentObserver: {
              daemonAvailable: true,
              getSnapshots: () => this.runtime.getActivitySnapshots(),
              subscribe: () => () => undefined,
              close: () => undefined,
            },
          }));
      this.pullRequestEventReconciliationEnabled = Boolean(reconcilePullRequestEvents);
      this.pullRequestSyncSupervisor = new PullRequestSyncSupervisor(this.paths, {
        ...configuredOptions,
        reconcileEvents: reconcilePullRequestEvents,
        minimumIntervalMs: configuredOptions.minimumIntervalMs ??
          (config.github?.watchIntervalSeconds ?? 5) * 1_000,
        onTasksChanged: async (taskIds) => {
          this.broadcastTasksChanged(taskIds);
          await configuredOptions.onTasksChanged?.(taskIds);
        },
        onError: async (error) => {
          await errorService.appendErrorLogBestEffort(this.paths, {
            context: "pull request sync supervisor",
            message: error instanceof Error ? error.message : String(error),
          });
          await configuredOptions.onError?.(error);
        },
      });
      this.pullRequestSyncSupervisor.start();
      this.updateRuntimeActivityEnabled();
    }
    const unfinished = (await listPromptCommands(this.paths))
      .some((command) => command.state === "queued" || command.state === "delivering") ||
      (await listFuryRuns(this.paths)).some((run) => run.cleanupPending || !["succeeded", "failed", "cancelled", "timed_out"].includes(run.state));
    if (configService.previews.isEnabled(config, "agentOrchestration") || unfinished) {
      await this.ensureOrchestrationSupervisor();
    }
  }

  async stop(): Promise<void> {
    await this.pullRequestSyncSupervisor?.stop();
    this.pullRequestSyncSupervisor = null;
    this.pullRequestEventReconciliationEnabled = false;
    this.updateRuntimeActivityEnabled();
    await this.orchestrationSupervisor?.stop();
    this.orchestrationSupervisor = null;
  }

  handleConnection(socket: Socket): void {
    let buffer = "";
    this.clients.add(socket);
    this.subscriptions.set(socket, {
      activityEnabled: false,
      tabId: null,
      view: null,
      rowKeys: [],
      pullRequestPollView: { selectedTaskId: null, reviewVisible: false },
      navigationEnabled: false,
    });
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += String(chunk);
      let newlineIndex = buffer.indexOf("\n");

      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        void this.handleLine(socket, line);
        newlineIndex = buffer.indexOf("\n");
      }
    });
    const removeClient = () => {
      this.clients.delete(socket);
      this.subscriptions.delete(socket);
      this.pullRequestSyncSupervisor?.setView(this.getPullRequestPollView());
      if (!this.hasActivitySubscribers()) {
        this.updateRuntimeActivityEnabled();
        this.clearPendingActivityBroadcasts();
      }
    };
    socket.on("close", removeClient);
    socket.on("error", removeClient);
  }

  disposeAll(): void {
    for (const timer of this.updateTimers.values()) {
      clearTimeout(timer);
    }
    this.updateTimers.clear();
    for (const timer of this.activityTimers.values()) {
      clearTimeout(timer);
    }
    this.activityTimers.clear();
    this.pendingActivities.clear();
    this.runtime.disposeAll();
  }

  sessionCount(): number {
    return this.runtime.sessionTabIds().length;
  }

  closeClients(): void {
    for (const client of this.clients) {
      client.destroy();
    }
    this.clients.clear();
    this.subscriptions.clear();
    this.updateRuntimeActivityEnabled();
  }

  private draining = false;
  private admittedRequests = 0;

  private async handleLine(socket: Socket, line: string): Promise<void> {
    if (line.trim().length === 0) {
      return;
    }

    let request: DaemonRequest;
    try {
      request = JSON.parse(line) as DaemonRequest;
    } catch {
      writeMessage(socket, { id: -1, ok: false, error: "Malformed daemon request." });
      return;
    }

    const readOnly = ["ping", "getActivitySnapshots", "getViewState", "hydrateSession"].includes(request.type);
    if (this.draining && !readOnly) {
      writeMessage(socket, { id: request.id, ok: false, error: "Runtime draining; retry after lifecycle reconciliation." });
      return;
    }
    this.admittedRequests += 1;
    try {
      const result = await this.handleRequest(socket, request);
      writeMessage(socket, {
        id: request.id,
        ok: true,
        ...(request.type === "ping"
          ? { ...this.identity, ghosttyTerminal: true, lifecycle: this.draining ? "draining" as const : "ready" as const, sessionCount: this.runtime.sessionTabIds().length }
          : {}),
        ...(request.type === "getActivitySnapshots" ? { activities: this.runtime.getActivitySnapshots() } : {}),
        ...(typeof result === "number" ? { deliveredCount: result } : result ? { view: result } : {}),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      writeMessage(socket, { id: request.id, ok: false, error: message });
    } finally { this.admittedRequests -= 1; }
  }

  private async handleRequest(socket: Socket, request: DaemonRequest): Promise<TerminalViewState | number | null> {
    switch (request.type) {
      case "attachExisting": throw new Error("Logical attachment requires the split runtime.");
      case "ping":
        return null;
      case "acknowledgeView":
      case "registerViewClient":
        throw new Error("Logical views require the split runtime.");
      case "ensureSession":
        {
          const existed = this.runtime.hasRunningSession(request.tabId);
          const capabilityToken = request.spec.env?.CRAIG_AGENT_CAPABILITY;
          if (!existed && capabilityToken) {
            try {
              await refreshAgentCapability(this.paths, {
                taskId: request.taskId, agentTabId: request.tabId, capabilityToken,
              });
            } catch {
              this.log({
                level: "warn", component: "orchestration", event: "capability.refresh.failed",
                message: "Could not refresh capability before launch; normal authorization still applies.",
                taskId: request.taskId, tabId: request.tabId,
              });
            }
          }
          const config = !existed ? await configService.load(this.paths) : null;
          const factory = this.emulatorFactoryOverride ?? (config?.previews?.ghosttyTerminal ? createGhosttyEmulator : createTerminalEmulator);
          const view = this.runtime.ensureSession(request.taskId, request.tabId, request.size, request.spec, factory);
          if (!existed) {
            this.log({
              level: "info",
              component: "pty",
              event: "spawned",
              message: "PTY session spawned.",
              taskId: request.taskId,
              tabId: request.tabId,
            });
          }
          this.attachedTabId = request.tabId;
          return this.subscribe(socket, request.tabId, view);
        }
      case "hydrateSession":
        return this.runtime.getViewState(request.tabId);
      case "write":
        this.runtime.write(request.input);
        return null;
      case "writeKey":
        this.runtime.writeKey(request.key);
        return null;
      case "scrollViewport":
        this.runtime.scrollViewport(request.lines);
        return this.runtime.getViewState(this.attachedTabId);
      case "resize":
        this.runtime.resize(request.size);
        return this.runtime.getViewState(this.attachedTabId);
      case "detach":
        if (this.attachedTabId) {
          this.log({
            level: "debug",
            component: "pty",
            event: "detached",
            message: "Client detached from PTY session.",
            tabId: this.attachedTabId,
          });
        }
        this.runtime.detach();
        this.attachedTabId = null;
        return null;
      case "disposeSession":
        this.log({
          level: "info",
          component: "pty",
          event: "disposed",
          message: "PTY session disposed because its tab was closed.",
          tabId: request.tabId,
          details: { reason: "tab_closed" },
        });
        this.runtime.disposeSession(request.tabId);
        if (this.attachedTabId === request.tabId) {
          this.attachedTabId = null;
        }
        return null;
      case "setViewUpdateMode":
        return this.runtime.getViewState(this.attachedTabId);
      case "setActivityEnabled":
        this.setActivityEnabled(socket, request.enabled);
        return null;
      case "subscribeView":
        return this.subscribe(socket, request.tabId, this.runtime.getViewState(request.tabId));
      case "pruneStale":
        // Foreground inventory can be incomplete. Only explicit tab/task closure
        // may dispose a session; a stale list cannot authorize termination.
        return null;
      case "getViewState":
        return this.runtime.getViewState(request.tabId);
      case "getActivitySnapshots":
        return null;
      case "setPullRequestPollView":
        this.setPullRequestPollView(socket, request.view);
        return null;
      case "subscribeNavigation": {
        const current = this.subscriptions.get(socket);
        if (current) this.subscriptions.set(socket, { ...current, navigationEnabled: true });
        return null;
      }
      case "openFile":
        return this.broadcastOpenFile(socket, request.path);
      case "wakeOrchestration":
        await this.ensureOrchestrationSupervisor();
        // A caller may hold the delegation lock, or be this supervisor creating
        // a Fury child. Acknowledge the wake without waiting for work that can
        // depend on the caller returning. Durable work is also heartbeat-backed.
        void this.orchestrationSupervisor!.wake().catch((error) =>
          errorService.appendErrorLogBestEffort(this.paths, {
            context: "orchestration supervisor wake",
            message: error instanceof Error ? error.message : String(error),
          }));
        return null;
      case "drainIfEmpty": {
        if (!this.onShutdown) throw new Error("Runtime startup is incomplete; retry drain after readiness.");
        // Admission closes synchronously, before the first inventory read.
        this.draining = true;
        try {
          if (this.sessionCount() !== 0 || this.admittedRequests !== 1 || this.orchestrationSupervisorStartup) {
            throw new Error("Sessions or admitted service work remain.");
          }
          const unfinished = async () => (await listPromptCommands(this.paths)).some((command) => command.state === "queued" || command.state === "delivering") ||
            (await listFuryRuns(this.paths)).some((run) => run.cleanupPending || !["succeeded", "failed", "cancelled", "timed_out"].includes(run.state));
          if (await unfinished()) throw new Error("Pending orchestration remains.");
          // Stop waits for admitted polling/reconciliation, without disposing PTYs.
          await this.stop();
          if (this.sessionCount() !== 0 || await unfinished()) {
            await this.start();
            throw new Error("Inventory changed while draining.");
          }
          setImmediate(() => this.onShutdown?.());
          return null;
        } catch (error) {
          this.draining = false;
          throw new Error(`Upgrade pending: ${error instanceof Error ? error.message : String(error)} Runtime preserved.`);
        }
      }
      case "shutdown":
        this.log({
          level: "warn",
          component: "daemon",
          event: "shutdown.requested",
          message: "PTY daemon shutdown was explicitly requested.",
          details: { liveSessionCount: this.runtime.sessionTabIds().length },
        });
        setTimeout(() => this.onShutdown?.(), 0);
        return null;
      default:
        return assertNever(request);
    }
  }

  private subscribe(socket: Socket, tabId: string | null, view: TerminalViewState): TerminalViewState {
    const current = this.subscriptions.get(socket);
    this.subscriptions.set(socket, {
      activityEnabled: current?.activityEnabled ?? false,
      tabId,
      view,
      rowKeys: view.rows.map(rowKey),
      pullRequestPollView: current?.pullRequestPollView ?? { selectedTaskId: null, reviewVisible: false },
      navigationEnabled: current?.navigationEnabled ?? false,
    });
    return view;
  }

  private setActivityEnabled(socket: Socket, enabled: boolean): void {
    const current = this.subscriptions.get(socket);
    if (!current) {
      return;
    }
    this.subscriptions.set(socket, { ...current, activityEnabled: enabled });
    const hasActivitySubscribers = this.hasActivitySubscribers();
    this.updateRuntimeActivityEnabled();
    if (!hasActivitySubscribers) {
      this.clearPendingActivityBroadcasts();
    }
  }

  private setPullRequestPollView(socket: Socket, view: GitHubPollView): void {
    const current = this.subscriptions.get(socket);
    if (!current) return;
    this.subscriptions.set(socket, { ...current, pullRequestPollView: view });
    this.pullRequestSyncSupervisor?.setView(this.getPullRequestPollView());
  }

  private getPullRequestPollView(): GitHubPollView {
    const views = [...this.subscriptions.values()].map((subscription) => subscription.pullRequestPollView);
    return views.find((view) => view.selectedTaskId && view.reviewVisible) ??
      views.find((view) => view.selectedTaskId) ??
      { selectedTaskId: null, reviewVisible: false };
  }

  private broadcastTasksChanged(taskIds: string[]): void {
    for (const client of this.clients) {
      writeMessage(client, { type: "tasksChanged", taskIds });
    }
  }

  private broadcastOpenFile(requester: Socket, filePath: string): number {
    let deliveredCount = 0;
    for (const [client, subscription] of this.subscriptions) {
      if (client === requester || !subscription.navigationEnabled) continue;
      writeMessage(client, { type: "openFile", path: filePath });
      deliveredCount += 1;
    }
    return deliveredCount;
  }

  private handleRuntimeUpdate(tabId: string): void {
    this.scheduleBroadcastUpdate(tabId);
  }

  private handleActivityUpdate(snapshot: PtyActivitySnapshot): void {
    if (snapshot.sessionState !== "running") {
      this.log({
        level: snapshot.sessionState === "failed" || snapshot.exitCode !== 0 ? "error" : "info",
        component: "pty",
        event: "exited",
        message: snapshot.sessionState === "failed" ? "PTY session failed." : "PTY process exited.",
        taskId: snapshot.taskId,
        tabId: snapshot.tabId,
        details: { sessionState: snapshot.sessionState, exitCode: snapshot.exitCode, error: snapshot.error },
      });
    }
    this.pullRequestSyncSupervisor?.notifyActivity(snapshot);
    if (!this.hasActivitySubscribers()) {
      return;
    }
    this.pendingActivities.set(snapshot.tabId, snapshot);
    if (snapshot.sessionState !== "running") {
      const timer = this.activityTimers.get(snapshot.tabId);
      if (timer) {
        clearTimeout(timer);
        this.activityTimers.delete(snapshot.tabId);
      }
      this.broadcastActivity(snapshot.tabId);
      return;
    }
    if (this.activityTimers.has(snapshot.tabId)) {
      return;
    }
    this.activityTimers.set(snapshot.tabId, setTimeout(() => {
      this.activityTimers.delete(snapshot.tabId);
      this.broadcastActivity(snapshot.tabId);
    }, ACTIVITY_UPDATE_INTERVAL_MS));
  }

  private handleActivityRemoved(tabId: string): void {
    this.pullRequestSyncSupervisor?.notifyActivityRemoved(tabId);
    const timer = this.activityTimers.get(tabId);
    if (timer) {
      clearTimeout(timer);
      this.activityTimers.delete(tabId);
    }
    this.pendingActivities.delete(tabId);
    for (const [client, subscription] of this.subscriptions) {
      if (subscription.activityEnabled) {
        writeMessage(client, { type: "activityRemoved", tabId });
      }
    }
  }

  private broadcastActivity(tabId: string): void {
    const snapshot = this.pendingActivities.get(tabId);
    if (!snapshot) {
      return;
    }
    this.pendingActivities.delete(tabId);
    for (const [client, subscription] of this.subscriptions) {
      if (subscription.activityEnabled) {
        writeMessage(client, { type: "activity", snapshot });
      }
    }
  }

  private hasActivitySubscribers(): boolean {
    return [...this.subscriptions.values()].some((subscription) => subscription.activityEnabled);
  }

  private clearPendingActivityBroadcasts(): void {
    for (const timer of this.activityTimers.values()) {
      clearTimeout(timer);
    }
    this.activityTimers.clear();
    this.pendingActivities.clear();
  }

  private async ensureOrchestrationSupervisor(): Promise<void> {
    if (this.orchestrationSupervisor) return;
    if (!this.orchestrationSupervisorStartup) {
      this.orchestrationSupervisorStartup = this.startOrchestrationSupervisor().finally(() => {
        this.orchestrationSupervisorStartup = null;
      });
    }
    this.orchestrationSupervisor = await this.orchestrationSupervisorStartup;
    this.updateRuntimeActivityEnabled();
  }

  private async startOrchestrationSupervisor(): Promise<OrchestrationSupervisor> {
    const supervisor = new OrchestrationSupervisor(this.paths, this.runtime, {
      onError: (error) => errorService.appendErrorLogBestEffort(this.paths, {
        context: "orchestration supervisor",
        message: error instanceof Error ? error.message : String(error),
      }),
    });
    try {
      await supervisor.start({ deferReconciliation: true });
      await errorService.appendLogBestEffort(this.paths, {
        level: "info",
        component: "orchestration",
        event: "supervisor.started",
        message: "Orchestration supervisor is ready.",
      });
      return supervisor;
    } catch (error) {
      await errorService.appendErrorLogBestEffort(this.paths, {
        context: "orchestration supervisor startup",
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  private updateRuntimeActivityEnabled(): void {
    this.runtime.setActivityEnabled(
      this.orchestrationSupervisor !== null ||
      this.pullRequestEventReconciliationEnabled ||
      this.hasActivitySubscribers(),
    );
  }

  private log(entry: Parameters<typeof errorService.appendLogBestEffort>[1]): void {
    void errorService.appendLogBestEffort(this.paths, entry);
  }

  private scheduleBroadcastUpdate(tabId: string): void {
    if (this.updateTimers.has(tabId) || !this.hasViewSubscriber(tabId)) {
      return;
    }

    this.updateTimers.set(tabId, setTimeout(() => {
      this.updateTimers.delete(tabId);
      this.broadcastUpdate(tabId);
    }, INCREMENTAL_VIEW_UPDATE_INTERVAL_MS));
  }

  private hasViewSubscriber(tabId: string): boolean {
    for (const subscription of this.subscriptions.values()) {
      if (subscription.tabId === tabId) {
        return true;
      }
    }
    return false;
  }

  private broadcastUpdate(tabId: string): void {
    const view = this.runtime.getViewState(tabId);
    for (const client of this.clients) {
      const subscription = this.subscriptions.get(client);
      if (!subscription || subscription.tabId !== tabId) {
        continue;
      }

      const patch = buildViewPatch(subscription, view);
      const metadataChanged = hasViewMetadataChanged(subscription.view, view);
      subscription.view = view;
      subscription.rowKeys = view.rows.map(rowKey);
      if (patch.rows.length > 0 || metadataChanged) {
        writeMessage(client, { type: "update", tabId, patch });
      }
    }
  }
}

function buildViewPatch(previous: ClientViewSubscription, view: TerminalViewState): TerminalViewPatch {
  const rows: TerminalViewPatch["rows"] = [];
  for (let index = 0; index < view.rows.length; index += 1) {
    const row = view.rows[index]!;
    if (previous.rowKeys[index] !== rowKey(row)) {
      rows.push({ index, row });
    }
  }

  return {
    status: view.status,
    error: view.error,
    scrolledBack: view.scrolledBack ?? false,
    rowCount: view.rows.length,
    rows,
  };
}

function hasViewMetadataChanged(previous: TerminalViewState | null, view: TerminalViewState): boolean {
  return !previous ||
    previous.status !== view.status ||
    previous.error !== view.error ||
    (previous.scrolledBack ?? false) !== (view.scrolledBack ?? false) ||
    previous.rows.length !== view.rows.length;
}

function hasPatchMetadataChanged(
  previous: TerminalViewState,
  patch: Pick<TerminalViewPatch, "status" | "error" | "scrolledBack" | "rowCount">,
): boolean {
  return previous.status !== patch.status ||
    previous.error !== patch.error ||
    (previous.scrolledBack ?? false) !== patch.scrolledBack ||
    previous.rows.length !== patch.rowCount;
}

function rowKey(row: TerminalScreenRow): string {
  return JSON.stringify(row);
}

async function canConnect(socketPath: string): Promise<boolean> {
  const socket = await connectToDaemon(socketPath).catch(() => null);
  if (!socket) {
    return false;
  }

  socket.end();
  return true;
}

async function shutdownDaemonSocket(socketPath: string): Promise<void> {
  await sendDaemonRequest(socketPath, { id: 1, type: "shutdown" }).catch(() => null);
}

function sendDaemonRequest(socketPath: string, request: DaemonRequest): Promise<DaemonResponse> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let buffer = "";
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error("Craig PTY daemon request timed out."));
    }, 500);

    const cleanup = () => clearTimeout(timeout);
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.once("error", (error) => {
      cleanup();
      reject(error);
    });
    socket.on("data", (chunk) => {
      buffer += String(chunk);
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex === -1) {
        return;
      }

      const line = buffer.slice(0, newlineIndex);
      cleanup();
      socket.end();
      try {
        resolve(JSON.parse(line) as DaemonResponse);
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
    socket.once("close", () => cleanup());
  });
}

function connectToDaemon(socketPath: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });
}

function listen(server: Server, socketPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
}

function writeMessage(socket: Socket, message: DaemonMessage): void {
  if (socket.destroyed) {
    return;
  }

  try {
    socket.write(`${JSON.stringify(message)}\n`);
  } catch {
    // Clients can detach while the daemon is broadcasting terminal output.
  }
}

function assertNever(value: never): never {
  throw new Error(`Unhandled daemon request: ${JSON.stringify(value)}`);
}
