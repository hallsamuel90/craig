import { createConnection, type Socket } from "node:net";

import type { PtyActivitySnapshot } from "../domain/agent/index.js";
import { isAgentCapabilityRefreshDue, refreshAgentCapability, type AgentCapabilitySession } from "../domain/orchestration/index.js";
import type { CraigPaths } from "../state/craig-paths.js";
import { getPtyDaemonEndpoint, isCompatiblePtyDaemonProtocol } from "./pty-daemon-protocol.js";

interface Response {
  id: number;
  ok: boolean;
  protocolVersion?: number;
  activities?: PtyActivitySnapshot[];
}

// Use the read-only API supported by older daemons, without restarting PTYs.
// This is a preflight check; normal command authorization still runs afterward.
export async function refreshLiveAgentCapability(paths: CraigPaths, session: AgentCapabilitySession): Promise<void> {
  try {
    if (!await isAgentCapabilityRefreshDue(paths, session)) return;
    const socket = createConnection(getPtyDaemonEndpoint(paths).socketPath);
    socket.on("error", () => undefined); // Keep late connection errors best effort, too.
    const timeout = setTimeout(() => socket.destroy(new Error("Capability refresh probe timed out.")), 1_000);
    try {
      const ping = await request(socket, 1, "ping");
      if (!isCompatiblePtyDaemonProtocol(ping.protocolVersion)) return;
      // Enabling observation rebuilds snapshots from the current PTY state;
      // cached activity can be stale when there were no activity subscribers.
      await request(socket, 2, "setActivityEnabled");
      const response = await request(socket, 3, "getActivitySnapshots");
      clearTimeout(timeout);
      socket.destroy();
      if (response.activities?.some((snapshot) =>
        snapshot.taskId === session.taskId && snapshot.tabId === session.agentTabId && snapshot.sessionState === "running")) {
        await refreshAgentCapability(paths, session);
      }
    } finally {
      clearTimeout(timeout);
      socket.destroy();
    }
  } catch {
    // An unavailable/old daemon or storage failure must not fail an otherwise
    // authorized command. Expired or revoked tokens still fail normal auth.
  }
}

function request(socket: Socket, id: number, type: "ping" | "setActivityEnabled" | "getActivitySnapshots"): Promise<Response> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const cleanup = () => {
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("close", onClose);
    };
    const onError = (error: Error) => { cleanup(); reject(error); };
    const onClose = () => onError(new Error("Daemon closed during capability refresh."));
    const onData = (chunk: Buffer | string) => {
      buffer += String(chunk);
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        try {
          const response = JSON.parse(line) as Response;
          if (response.id === id) {
            cleanup();
            if (response.ok) resolve(response);
            else reject(new Error("Daemon rejected capability refresh probe."));
            return;
          }
        } catch {
          onError(new Error("Invalid daemon response during capability refresh."));
          return;
        }
        newline = buffer.indexOf("\n");
      }
    };
    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("close", onClose);
    socket.write(`${JSON.stringify({ id, type, ...(type === "setActivityEnabled" ? { enabled: true } : {}) })}\n`);
  });
}
