import { createConnection, type Socket } from "node:net";

import type { CraigPaths } from "../state/craig-paths.js";
import { getPtyDaemonEndpoint, PTY_DAEMON_PROTOCOL_VERSION } from "./pty-daemon-protocol.js";

interface NavigationResponse {
  ok: boolean;
  protocolVersion?: number;
  deliveredCount?: number;
  error?: string;
}

export async function requestOpenFile(paths: CraigPaths, filePath: string): Promise<boolean> {
  const socket = await connect(getPtyDaemonEndpoint(paths).socketPath).catch(() => null);
  if (!socket) return false;
  try {
    const ping = await request(socket, { type: "ping" });
    if (ping.protocolVersion !== PTY_DAEMON_PROTOCOL_VERSION) return false;
    const response = await request(socket, { type: "openFile", path: filePath });
    return (response.deliveredCount ?? 0) > 0;
  } catch {
    return false;
  } finally {
    socket.end();
  }
}

let requestId = 1;

function request(socket: Socket, input: { type: "ping" } | { type: "openFile"; path: string }): Promise<NavigationResponse> {
  const id = requestId++;
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timeout = setTimeout(() => {
      cleanup();
      socket.destroy();
      reject(new Error("Craig UI navigation request timed out."));
    }, 1_000);
    const onData = (chunk: Buffer | string) => {
      buffer += String(chunk);
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      cleanup();
      const response = JSON.parse(buffer.slice(0, newline)) as NavigationResponse;
      if (!response.ok) reject(new Error(response.error ?? "Craig UI navigation request failed."));
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
