import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";

import type { CraigPaths } from "../state/craig-paths.js";

export const PTY_DAEMON_PROTOCOL_VERSION = 10;
const COMPATIBLE_PTY_DAEMON_PROTOCOL_VERSIONS = new Set([6, 7, 8, 9, PTY_DAEMON_PROTOCOL_VERSION]);

export function isCompatiblePtyDaemonProtocol(version: number | undefined): boolean {
  return version !== undefined && COMPATIBLE_PTY_DAEMON_PROTOCOL_VERSIONS.has(version);
}

export function getPtyDaemonEndpoint(paths: CraigPaths): { socketPath: string; pidPath: string } {
  const workspaceHash = createHash("sha256").update(paths.workspaceRoot).digest("hex").slice(0, 16);
  return {
    socketPath: path.join(tmpdir(), `craig-${workspaceHash}.sock`),
    pidPath: path.join(paths.runtimeDir, "pty-daemon.pid"),
  };
}
