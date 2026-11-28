// Frozen launch-path fixture from a2a1fbcd146898bc46c396ae957942d6c3041b9a:src/shell/pty-daemon-orchestration.ts.
// Only dependencies and export visibility are adapted for isolated tests.
import { createConnection, type Socket } from "node:net";
import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import type { CraigPaths } from "../../../src/state/craig-paths.js";
const isCompatiblePtyDaemonProtocol = (version: number | undefined) => version !== undefined && [6, 7, 8, 9, 10].includes(version);
let spawns = 0;
function spawnPtyDaemonProcess(..._args: unknown[]) { void _args; spawns++; }
export function spawnCount() { return spawns; }
function getPtyDaemonEndpoint(paths: CraigPaths) { return { socketPath: path.join(paths.runtimeDir, "fixture.sock"), pidPath: path.join(paths.runtimeDir, "pty-daemon.pid") }; }
export async function ensureDaemonRunning(paths: CraigPaths): Promise<void> {
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
