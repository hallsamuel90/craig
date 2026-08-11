import { createConnection, type Socket } from "node:net";

import type { CraigPaths } from "../state/craig-paths.js";
import { getPtyDaemonEndpoint, PTY_DAEMON_PROTOCOL_VERSION } from "./pty-daemon-protocol.js";

export async function wakeOrchestrationSupervisor(paths: CraigPaths): Promise<boolean> {
  const socket = await connect(getPtyDaemonEndpoint(paths).socketPath).catch(() => null);
  if (!socket) return false;
  try {
    const ping = await request(socket, { type: "ping" });
    if (ping.protocolVersion !== PTY_DAEMON_PROTOCOL_VERSION) return false;
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
    if (ping.protocolVersion !== PTY_DAEMON_PROTOCOL_VERSION) return false;
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
  const socket = await connect(getPtyDaemonEndpoint(paths).socketPath).catch(() => null);
  if (!socket) throw new Error("Craig PTY daemon is unavailable for delegated agent startup.");
  try {
    const ping = await request(socket, { type: "ping" });
    if (ping.protocolVersion !== PTY_DAEMON_PROTOCOL_VERSION) {
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
    const timeout = setTimeout(() => reject(new Error("Craig PTY daemon request timed out.")), 1_000);
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
