import { spawn as spawnChild } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer, createConnection, type Socket, type Server } from "node:net";
import { openSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { CraigPaths } from "../../state/craig-paths.js";
import { resolveExecutablePath } from "../../shared/command-path.js";
import type { TerminalViewState } from "../state.js";
import type { TerminalScreenRow } from "../terminal-emulator.js";
import { PtyRuntime, type PtyRuntimeOptions, type PtySessionSpec, type PtySize } from "./runtime.js";

const DAEMON_PROTOCOL_VERSION = 4;
const VIEW_UPDATE_INTERVAL_MS = 50;

export type PtyViewUpdateMode = "snapshot" | "incremental";

type DaemonRequest =
  | { id: number; type: "ping" }
  | { id: number; type: "ensureSession"; taskId: string; tabId: string; size: PtySize; spec: PtySessionSpec }
  | { id: number; type: "hydrateSession"; tabId: string }
  | { id: number; type: "pruneStale"; keepTabIds: string[] }
  | { id: number; type: "write"; input: string }
  | { id: number; type: "writeKey"; key: string }
  | { id: number; type: "scrollViewport"; lines: number }
  | { id: number; type: "resize"; size: PtySize }
  | { id: number; type: "detach" }
  | { id: number; type: "disposeSession"; tabId: string }
  | { id: number; type: "setViewUpdateMode"; mode: PtyViewUpdateMode }
  | { id: number; type: "subscribeView"; tabId: string | null }
  | { id: number; type: "getViewState"; tabId: string | null }
  | { id: number; type: "shutdown" };

type DaemonResponse =
  | { id: number; ok: true; protocolVersion?: number; view?: TerminalViewState }
  | { id: number; ok: false; error: string };
type DaemonOkResponse = Extract<DaemonResponse, { ok: true }>;

interface TerminalViewPatch {
  status: TerminalViewState["status"];
  error: string | null;
  scrolledBack: boolean;
  rowCount: number;
  rows: Array<{ index: number; row: TerminalScreenRow }>;
}

type DaemonEvent =
  | { type: "update"; tabId: string; view: TerminalViewState }
  | { type: "update"; tabId: string; patch: TerminalViewPatch };
type DaemonMessage = DaemonResponse | DaemonEvent;

interface ClientViewSubscription {
  mode: PtyViewUpdateMode;
  tabId: string | null;
  view: TerminalViewState | null;
  rowKeys: string[];
}

/* eslint-disable no-unused-vars */
interface PendingRequest {
  resolve: (response: DaemonResponse) => void;
  reject: (error: Error) => void;
}

export interface DaemonPtyRuntimeOptions extends PtyRuntimeOptions {
  paths: CraigPaths;
  spawnDaemon?: (workspaceRoot: string) => void;
  viewUpdateMode?: PtyViewUpdateMode;
}
/* eslint-enable no-unused-vars */

export async function createDaemonPtyRuntime(options: DaemonPtyRuntimeOptions): Promise<DaemonPtyRuntimeClient> {
  const endpoint = getDaemonEndpoint(options.paths);
  await ensureDaemonRunning(endpoint, options.paths, options.spawnDaemon);
  const socket = await connectToDaemon(endpoint.socketPath);
  const client = new DaemonPtyRuntimeClient(socket, options);
  await client.ready();
  return client;
}

export async function servePtyDaemon(paths: CraigPaths, options: Partial<PtyRuntimeOptions> = {}): Promise<void> {
  const endpoint = getDaemonEndpoint(paths);
  await mkdir(paths.runtimeDir, { recursive: true });
  await rm(endpoint.socketPath, { force: true });
  const daemon = new PtyDaemonServer(paths, options);
  const server = createServer((socket) => daemon.handleConnection(socket));
  await listen(server, endpoint.socketPath);
  await writeFile(endpoint.pidPath, String(process.pid), "utf8");

  await new Promise<void>((resolve) => {
    const close = () => {
      daemon.closeClients();
      server.close(() => resolve());
    };

    daemon.onShutdown = close;
    process.once("SIGTERM", close);
    process.once("SIGINT", close);
  });

  await rm(endpoint.socketPath, { force: true });
  await rm(endpoint.pidPath, { force: true });
  daemon.disposeAll();
}

export async function requestDaemonShutdown(paths: CraigPaths): Promise<boolean> {
  const endpoint = getDaemonEndpoint(paths);
  if (!(await canConnect(endpoint.socketPath))) {
    return false;
  }

  await shutdownDaemonSocket(endpoint.socketPath);
  return true;
}

export class DaemonPtyRuntimeClient {
  private nextRequestId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly viewCache = new Map<string, TerminalViewState>();
  private attachedTabId: string | null = null;
  private viewedTabId: string | null = null;
  private subscribedTabId: string | null = null;
  private viewUpdateMode: PtyViewUpdateMode;
  private buffer = "";
  private closed = false;
  private readonly options: DaemonPtyRuntimeOptions;

  constructor(private readonly socket: Socket, options: DaemonPtyRuntimeOptions) {
    this.options = options;
    this.viewUpdateMode = options.viewUpdateMode ?? "snapshot";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => this.handleData(String(chunk)));
    socket.on("error", (error) => this.rejectAll(error instanceof Error ? error : new Error(String(error))));
    socket.on("close", () => {
      this.closed = true;
      this.rejectAll(new Error("Craig PTY daemon connection closed."));
    });
  }

  async ready(): Promise<void> {
    const response = await this.send({ type: "ping" });
    if (response.protocolVersion !== DAEMON_PROTOCOL_VERSION) {
      throw new Error("Craig PTY daemon protocol mismatch.");
    }
    await this.send({ type: "setViewUpdateMode", mode: this.viewUpdateMode });
  }

  async ensureSession(taskId: string, tabId: string, size: PtySize): Promise<TerminalViewState> {
    const response = await this.send({
      type: "ensureSession",
      taskId,
      tabId,
      size,
      spec: this.options.resolveSessionSpec?.(taskId, tabId) ?? { cwd: this.options.workspaceRoot, command: [] },
    });
    this.attachedTabId = tabId;
    this.viewedTabId = tabId;
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
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.viewCache.set(tabId, { status: "failed", rows: [], error: message });
      }
    }
  }

  async pruneStale(keepTabIds: string[]): Promise<void> {
    await this.send({ type: "pruneStale", keepTabIds });
  }

  write(input: string): void {
    void this.send({ type: "write", input }).catch(() => undefined);
  }

  writeKey(key: string): void {
    void this.send({ type: "writeKey", key }).catch(() => undefined);
  }

  scrollViewport(lines: number): void {
    void this.send({ type: "scrollViewport", lines }).then((response) => {
      if (this.attachedTabId && response.view) {
        this.viewCache.set(this.attachedTabId, response.view);
      }
    }).catch(() => undefined);
  }

  resize(size: PtySize): void {
    void this.send({ type: "resize", size }).then((response) => {
      if (this.attachedTabId && response.view) {
        this.viewCache.set(this.attachedTabId, response.view);
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
    if (this.viewUpdateMode === "incremental") {
      this.subscribeToView(tabId);
    }
  }

  setViewUpdateMode(mode: PtyViewUpdateMode): void {
    if (this.closed || this.viewUpdateMode === mode) {
      return;
    }

    this.viewUpdateMode = mode;
    this.subscribedTabId = null;
    const viewedTabId = this.viewedTabId;
    void this.send({ type: "setViewUpdateMode", mode }).then((response) => {
      if (viewedTabId && response.view) {
        this.viewCache.set(viewedTabId, response.view);
      }
      if (this.viewUpdateMode === mode && this.viewedTabId === viewedTabId) {
        this.options.onUpdate?.(viewedTabId ?? "");
      }
      if (mode === "incremental" && this.viewUpdateMode === mode) {
        if (this.viewedTabId === viewedTabId && this.subscribedTabId === null) {
          this.subscribedTabId = viewedTabId;
        } else if (this.viewedTabId !== viewedTabId) {
          this.subscribeToView(this.viewedTabId);
        }
      }
    }).catch(() => {
      if (this.viewUpdateMode === mode) {
        this.subscribedTabId = null;
      }
    });
  }

  disposeSession(tabId: string): void {
    this.viewCache.delete(tabId);
    if (this.attachedTabId === tabId) {
      this.attachedTabId = null;
    }
    void this.send({ type: "disposeSession", tabId }).catch(() => undefined);
  }

  disposeAll(): void {
    this.attachedTabId = null;
    if (this.closed) {
      return;
    }

    this.socket.end();
    this.closed = true;
  }

  getViewState(tabId: string | null): TerminalViewState {
    if (!tabId) {
      return { status: "idle", rows: [], error: null, scrolledBack: false };
    }

    return this.viewCache.get(tabId) ?? { status: "idle", rows: [], error: null, scrolledBack: false };
  }

  async requestShutdown(): Promise<void> {
    await this.send({ type: "shutdown" });
  }

  private async send(request: Omit<DaemonRequest, "id"> & Record<string, unknown>): Promise<DaemonOkResponse> {
    if (this.closed) {
      throw new Error("Craig PTY daemon connection is closed.");
    }

    const id = this.nextRequestId;
    this.nextRequestId += 1;
    const payload = { ...request, id } as DaemonRequest;
    const response = new Promise<DaemonResponse>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    if (this.socket.destroyed) {
      this.pending.delete(id);
      throw new Error("Craig PTY daemon connection is closed.");
    }

    this.socket.write(`${JSON.stringify(payload)}\n`);
    const resolved = await response;
    if (!resolved.ok) {
      throw new Error(resolved.error);
    }
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

    if (message.type === "update") {
      if ("view" in message) {
        this.viewCache.set(message.tabId, message.view);
        this.options.onUpdate?.(message.tabId);
        return;
      }

      const current = this.viewCache.get(message.tabId) ?? { status: "idle" as const, rows: [], error: null, scrolledBack: false };
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
      if (this.viewUpdateMode === "incremental" && this.viewedTabId === message.tabId) {
        this.options.onUpdate?.(message.tabId);
      }
    }
  }

  private subscribeToView(tabId: string | null): void {
    if (this.closed || this.viewUpdateMode !== "incremental" || this.subscribedTabId === tabId) {
      return;
    }

    this.subscribedTabId = tabId;
    void this.send({ type: "subscribeView", tabId }).then((response) => {
      if (tabId && response.view) {
        this.viewCache.set(tabId, response.view);
      }
      if (this.viewUpdateMode === "incremental" && this.viewedTabId === tabId && this.subscribedTabId === tabId) {
        this.options.onUpdate?.(tabId ?? "");
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
}

class PtyDaemonServer {
  onShutdown: (() => void) | null = null;
  private readonly clients = new Set<Socket>();
  private readonly subscriptions = new Map<Socket, ClientViewSubscription>();
  private readonly updateTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly runtime: PtyRuntime;
  private attachedTabId: string | null = null;

  constructor(paths: CraigPaths, options: Partial<PtyRuntimeOptions>) {
    this.runtime = new PtyRuntime({
      ...options,
      workspaceRoot: paths.workspaceRoot,
      onUpdate: (tabId) => this.handleRuntimeUpdate(tabId),
    });
  }

  handleConnection(socket: Socket): void {
    let buffer = "";
    this.clients.add(socket);
    this.subscriptions.set(socket, { mode: "snapshot", tabId: null, view: null, rowKeys: [] });
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
    };
    socket.on("close", removeClient);
    socket.on("error", removeClient);
  }

  disposeAll(): void {
    for (const timer of this.updateTimers.values()) {
      clearTimeout(timer);
    }
    this.updateTimers.clear();
    this.runtime.disposeAll();
  }

  closeClients(): void {
    for (const client of this.clients) {
      client.destroy();
    }
    this.clients.clear();
    this.subscriptions.clear();
  }

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

    try {
      const view = this.handleRequest(socket, request);
      writeMessage(socket, {
        id: request.id,
        ok: true,
        ...(request.type === "ping" ? { protocolVersion: DAEMON_PROTOCOL_VERSION } : {}),
        ...(view ? { view } : {}),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      writeMessage(socket, { id: request.id, ok: false, error: message });
    }
  }

  private handleRequest(socket: Socket, request: DaemonRequest): TerminalViewState | null {
    switch (request.type) {
      case "ping":
        return null;
      case "ensureSession":
        this.attachedTabId = request.tabId;
        return this.subscribe(socket, request.tabId, this.runtime.ensureSession(request.taskId, request.tabId, request.size, request.spec));
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
        this.runtime.detach();
        this.attachedTabId = null;
        return null;
      case "disposeSession":
        this.runtime.disposeSession(request.tabId);
        if (this.attachedTabId === request.tabId) {
          this.attachedTabId = null;
        }
        return null;
      case "setViewUpdateMode":
        return this.setViewUpdateMode(socket, request.mode);
      case "subscribeView":
        return this.subscribe(socket, request.tabId, this.runtime.getViewState(request.tabId));
      case "pruneStale": {
        const keep = new Set(request.keepTabIds);
        for (const tabId of this.runtime.sessionTabIds()) {
          if (!keep.has(tabId)) {
            this.runtime.disposeSession(tabId);
            if (this.attachedTabId === tabId) {
              this.attachedTabId = null;
            }
          }
        }
        return null;
      }
      case "getViewState":
        return this.runtime.getViewState(request.tabId);
      case "shutdown":
        setTimeout(() => this.onShutdown?.(), 0);
        return null;
      default:
        return assertNever(request);
    }
  }

  private subscribe(socket: Socket, tabId: string | null, view: TerminalViewState): TerminalViewState {
    const mode = this.subscriptions.get(socket)?.mode ?? "snapshot";
    this.subscriptions.set(socket, {
      mode,
      tabId,
      view,
      rowKeys: view.rows.map(rowKey),
    });
    return view;
  }

  private setViewUpdateMode(socket: Socket, mode: PtyViewUpdateMode): TerminalViewState {
    const current = this.subscriptions.get(socket);
    const tabId = current?.tabId ?? null;
    const view = this.runtime.getViewState(tabId);
    this.subscriptions.set(socket, {
      mode,
      tabId,
      view,
      rowKeys: view.rows.map(rowKey),
    });
    return view;
  }

  private handleRuntimeUpdate(tabId: string): void {
    const view = this.runtime.getViewState(tabId);
    for (const client of this.clients) {
      const subscription = this.subscriptions.get(client);
      if (subscription?.mode === "snapshot") {
        writeMessage(client, { type: "update", tabId, view });
      }
    }
    this.scheduleBroadcastUpdate(tabId);
  }

  private scheduleBroadcastUpdate(tabId: string): void {
    if (this.updateTimers.has(tabId) || !this.hasViewSubscriber(tabId)) {
      return;
    }

    this.updateTimers.set(tabId, setTimeout(() => {
      this.updateTimers.delete(tabId);
      this.broadcastUpdate(tabId);
    }, VIEW_UPDATE_INTERVAL_MS));
  }

  private hasViewSubscriber(tabId: string): boolean {
    for (const subscription of this.subscriptions.values()) {
      if (subscription.mode === "incremental" && subscription.tabId === tabId) {
        return true;
      }
    }
    return false;
  }

  private broadcastUpdate(tabId: string): void {
    const view = this.runtime.getViewState(tabId);
    for (const client of this.clients) {
      const subscription = this.subscriptions.get(client);
      if (!subscription || subscription.mode !== "incremental" || subscription.tabId !== tabId) {
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

function rowKey(row: TerminalScreenRow): string {
  return JSON.stringify(row);
}

function getDaemonEndpoint(paths: CraigPaths): { socketPath: string; pidPath: string } {
  const workspaceHash = createHash("sha256").update(paths.workspaceRoot).digest("hex").slice(0, 16);
  return {
    socketPath: path.join(tmpdir(), `craig-${workspaceHash}.sock`),
    pidPath: path.join(paths.runtimeDir, "pty-daemon.pid"),
  };
}

/* eslint-disable no-unused-vars */
async function ensureDaemonRunning(
  endpoint: { socketPath: string; pidPath: string },
  paths: CraigPaths,
  spawnDaemon?: (workspaceRoot: string) => void,
): Promise<void> {
  /* eslint-enable no-unused-vars */
  if (await waitForCompatibleDaemon(endpoint.socketPath, 1000)) {
    return;
  }

  if (await canConnect(endpoint.socketPath)) {
    await shutdownDaemonSocket(endpoint.socketPath);
    await waitForDisconnect(endpoint.socketPath, 1000);
  }

  if (await canConnect(endpoint.socketPath)) {
    await terminateDaemonProcess(endpoint);
    await waitForDisconnect(endpoint.socketPath, 1000);
  }

  await cleanupStaleEndpoint(endpoint);
  const workspaceRoot = paths.workspaceRoot;
  if (spawnDaemon) {
    spawnDaemon(workspaceRoot);
  } else {
    const { command, args } = getDaemonSpawnCommand(workspaceRoot);
    const logFd = openSync(path.join(paths.runtimeDir, "pty-daemon.log"), "a");
    const child = spawnChild(command, args, {
      cwd: workspaceRoot,
      detached: true,
      stdio: ["ignore", logFd, logFd],
      env: process.env,
    });
    child.unref();
  }

  const started = Date.now();
  while (Date.now() - started < 5000) {
    if (await canConnectCompatible(endpoint.socketPath)) {
      return;
    }

    await delay(50);
  }

  const log = await readFile(path.join(paths.runtimeDir, "pty-daemon.log"), "utf8").catch(() => "");
  throw new Error(`Craig PTY daemon did not start.${log ? `\n${log.slice(-2000)}` : ""}`);
}

async function canConnectCompatible(socketPath: string): Promise<boolean> {
  const response = await requestDaemonPing(socketPath).catch(() => null);
  return response?.ok === true && response.protocolVersion === DAEMON_PROTOCOL_VERSION;
}

async function waitForCompatibleDaemon(socketPath: string, timeoutMs: number): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await canConnectCompatible(socketPath)) {
      return true;
    }

    await delay(50);
  }

  return false;
}

function getDaemonSpawnCommand(workspaceRoot: string): { command: string; args: string[] } {
  const entrypoint = process.argv[1];
  if (entrypoint?.endsWith(".ts")) {
    const localTsx = path.resolve(path.dirname(entrypoint), "..", "node_modules", ".bin", "tsx");
    return {
      command: resolveExecutablePath("tsx") ?? localTsx,
      args: [entrypoint, "__craig-daemon", workspaceRoot],
    };
  }

  const argv = process.argv.slice(1);
  return {
    command: process.execPath,
    args: [...process.execArgv, ...argv, "__craig-daemon", workspaceRoot],
  };
}

async function cleanupStaleEndpoint(endpoint: { socketPath: string; pidPath: string }): Promise<void> {
  const pidText = await readFile(endpoint.pidPath, "utf8").catch(() => null);
  if (pidText) {
    const pid = Number(pidText.trim());
    if (Number.isInteger(pid) && pid > 0 && isProcessAlive(pid)) {
      return;
    }
  }

  await rm(endpoint.socketPath, { force: true });
  await rm(endpoint.pidPath, { force: true });
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

async function terminateDaemonProcess(endpoint: { socketPath: string; pidPath: string }): Promise<void> {
  const pidText = await readFile(endpoint.pidPath, "utf8").catch(() => null);
  const pid = Number(pidText?.trim());
  if (!Number.isInteger(pid) || pid <= 0 || !isProcessAlive(pid)) {
    await rm(endpoint.socketPath, { force: true });
    return;
  }

  try {
    process.kill(pid, "SIGTERM");
  } catch {
    await rm(endpoint.socketPath, { force: true });
  }
}

async function requestDaemonPing(socketPath: string): Promise<DaemonResponse> {
  return sendDaemonRequest(socketPath, { id: 1, type: "ping" });
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

async function waitForDisconnect(socketPath: string, timeoutMs: number): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (!(await canConnect(socketPath))) {
      return;
    }

    await delay(50);
  }
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

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assertNever(value: never): never {
  throw new Error(`Unhandled daemon request: ${JSON.stringify(value)}`);
}
