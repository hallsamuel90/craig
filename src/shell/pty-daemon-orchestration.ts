import { mkdir, readFile, rm } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import path from "node:path";

import type { CraigPaths } from "../state/craig-paths.js";
import { getPtyDaemonEndpoint, isCompatiblePtyDaemonProtocol } from "./pty-daemon-protocol.js";
import { spawnPtyDaemonProcess } from "./pty-daemon-process.js";

export async function wakeOrchestrationSupervisor(paths: CraigPaths): Promise<boolean> {
  const socket = await connect(getPtyDaemonEndpoint(paths).socketPath).catch(() => null);
  if (!socket) return false;
  try {
    const ping = await request(socket, { type: "ping" });
    if (!isCompatiblePtyDaemonProtocol(ping.protocolVersion)) return false;
    await request(socket, { type: "wakeOrchestration" });
    return true;
  } catch {
    return false;
  } finally {
    socket.end();
  }
}

export async function disposeDaemonSessions(paths: CraigPaths, tabIds: string[]): Promise<boolean> {
  if (tabIds.length === 0) return true;
  const socket = await connect(getPtyDaemonEndpoint(paths).socketPath).catch(() => null);
  if (!socket) return false;
  try {
    const ping = await request(socket, { type: "ping" });
    if (!isCompatiblePtyDaemonProtocol(ping.protocolVersion)) return false;
    for (const tabId of tabIds) await request(socket, { type: "disposeSession", tabId });
    return true;
  } catch {
    return false;
  } finally {
    socket.end();
  }
}

export async function ensureDaemonAgentSession(
  paths: CraigPaths,
  input: {
    taskId: string;
    tabId: string;
    cwd: string;
    command: string[];
    env?: Record<string, string>;
  },
): Promise<void> {
  await ensureDaemonRunning(paths);
  const socket = await connect(getPtyDaemonEndpoint(paths).socketPath);
  try {
    const ping = await request(socket, { type: "ping" });
    if (!isCompatiblePtyDaemonProtocol(ping.protocolVersion)) {
      throw new Error("Craig PTY daemon protocol mismatch during delegated agent startup.");
    }
    await request(socket, {
      type: "ensureSession",
      taskId: input.taskId,
      tabId: input.tabId,
      size: { columns: 120, rows: 36 },
      spec: { cwd: input.cwd, command: input.command, ...(input.env ? { env: input.env } : {}) },
    });
  } finally {
    socket.end();
  }
}

async function ensureDaemonRunning(paths: CraigPaths): Promise<void> {
  const endpoint = getPtyDaemonEndpoint(paths);
  const existing = await ping(endpoint.socketPath).catch(() => null);
  if (isCompatiblePtyDaemonProtocol(existing?.protocolVersion)) return;
  if (existing) {
    throw new Error("A live Craig PTY daemon is using an incompatible protocol. Exit the other Craig instance and restart explicitly.");
  }

  await mkdir(paths.runtimeDir, { recursive: true });
  const pidText = await readFile(endpoint.pidPath, "utf8").catch(() => null);
  const pid = Number(pidText?.trim());
  if (Number.isInteger(pid) && pid > 0 && isProcessAlive(pid)) {
    throw new Error("A Craig PTY daemon process is still running but is not accepting connections. Stop it explicitly before starting another daemon.");
  }
  await Promise.all([rm(endpoint.socketPath, { force: true }), rm(endpoint.pidPath, { force: true })]);
  spawnPtyDaemonProcess(paths);

  const startedAt = Date.now();
  while (Date.now() - startedAt < 5_000) {
    const response = await ping(endpoint.socketPath).catch(() => null);
    if (isCompatiblePtyDaemonProtocol(response?.protocolVersion)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const log = await readFile(path.join(paths.runtimeDir, "pty-daemon.log"), "utf8").catch(() => "");
  throw new Error(`Craig PTY daemon did not start.${log ? `\n${log.slice(-2000)}` : ""}`);
}

async function ping(socketPath: string): Promise<Response> {
  const socket = await connect(socketPath);
  try { return await request(socket, { type: "ping" }); }
  finally { socket.end(); }
}

function isProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch { return false; }
}

interface Response {
  id: number;
  ok: boolean;
  protocolVersion?: number;
  error?: string;
}

let requestId = 1;

function request(socket: Socket, input:
  | { type: "ping" | "wakeOrchestration" }
  | { type: "disposeSession"; tabId: string }
  | {
      type: "ensureSession";
      taskId: string;
      tabId: string;
      size: { columns: number; rows: number };
      spec: { cwd: string; command: string[]; env?: Record<string, string> };
    },
): Promise<Response> {
  const id = requestId++;
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timeout = setTimeout(() => {
      cleanup();
      socket.destroy();
      reject(new Error("Craig PTY daemon request timed out."));
    }, 1_000);
    const onData = (chunk: Buffer | string) => {
      buffer += String(chunk);
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      cleanup();
      const response = JSON.parse(buffer.slice(0, newline)) as Response;
      if (!response.ok) reject(new Error(response.error ?? "Craig PTY daemon request failed."));
      else resolve(response);
    };
    const cleanup = () => {
      clearTimeout(timeout);
      socket.off("data", onData);
    };
    socket.on("data", onData);
    socket.write(`${JSON.stringify({ ...input, id })}\n`);
  });
}

function connect(socketPath: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });
}
