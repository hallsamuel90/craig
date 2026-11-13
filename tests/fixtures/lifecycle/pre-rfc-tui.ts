// Frozen launch-path fixture from a2a1fbcd146898bc46c396ae957942d6c3041b9a:src/ui/pty/daemon.ts.
// Only dependencies and export visibility are adapted for isolated tests.
import { createConnection, type Socket } from "node:net";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import type { CraigPaths } from "../../../src/state/craig-paths.js";
const isCompatiblePtyDaemonProtocol = (version: number | undefined) => version !== undefined && [6, 7, 8, 9, 10].includes(version);
const errorService = { appendLogBestEffort: async (..._args: unknown[]) => { void _args; } };
let spawns = 0;
function spawnPtyDaemonProcess(..._args: unknown[]) { void _args; spawns++; }
export function spawnCount() { return spawns; }
type DaemonRequest = { id: number; type: "ping" | "shutdown" };
type DaemonResponse = { id: number; ok: boolean; protocolVersion?: number; sessionCount?: number; error?: string };
/* eslint-disable no-unused-vars */
export async function ensureDaemonRunning(
  endpoint: { socketPath: string; pidPath: string },
  paths: CraigPaths,
  spawnDaemon?: (workspaceRoot: string) => void,
): Promise<void> {
  /* eslint-enable no-unused-vars */
  if (await waitForCompatibleDaemon(endpoint.socketPath, 1000)) {
    return;
  }

  if (await canConnect(endpoint.socketPath)) {
    const status = await requestDaemonPing(endpoint.socketPath).catch(() => null);
    const protocol = status?.ok ? status.protocolVersion ?? "unknown" : "unknown";
    const sessionCount = status?.ok ? status.sessionCount ?? "unknown" : "unknown";
    await errorService.appendLogBestEffort(paths, {
      level: "warn",
      component: "daemon",
      event: "upgrade.blocked",
      message: `Left incompatible protocol ${protocol} daemon running to preserve possible live PTYs.`,
      details: { protocolVersion: protocol, sessionCount },
    });
    throw new Error(
      "A live Craig PTY daemon is using an incompatible protocol. Exit the other Craig instance and restart explicitly; this client will not replace a live workspace daemon.",
    );
  }

  await cleanupStaleEndpoint(endpoint, paths);
  spawnPtyDaemonProcess(paths, spawnDaemon);

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
  return response?.ok === true && isCompatibleDaemonProtocol(response.protocolVersion);
}

function isCompatibleDaemonProtocol(version: number | undefined): boolean {
  return isCompatiblePtyDaemonProtocol(version);
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

async function cleanupStaleEndpoint(
  endpoint: { socketPath: string; pidPath: string },
  paths: CraigPaths,
): Promise<void> {
  const pidText = await readFile(endpoint.pidPath, "utf8").catch(() => null);
  if (pidText) {
    const pid = Number(pidText.trim());
    if (Number.isInteger(pid) && pid > 0 && isProcessAlive(pid)) {
      return;
    }
    await errorService.appendLogBestEffort(paths, {
      level: "warn",
      component: "daemon",
      event: "previous_exit.unclean",
      message: "Found stale daemon state from a process that is no longer running.",
      details: { previousPid: Number.isInteger(pid) ? pid : null },
    });
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

function connectToDaemon(socketPath: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });
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
