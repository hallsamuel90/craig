import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import type { CraigPaths } from "../../state/craig-paths.js";
import { getPtyDaemonEndpoint } from "../pty-daemon-protocol.js";
import type { RuntimeRecord } from "./records.js";

/** Read-only discovery; the legacy endpoint remains exclusively the guard's. */
export function getClientRuntimeEndpoint(paths: CraigPaths): { socketPath: string; pidPath: string } {
  const file = path.join(paths.runtimeDir, "control.json");
  let metadata;
  try { metadata = lstatSync(file); }
  catch (error) { if ((error as { code?: string }).code === "ENOENT") return getPtyDaemonEndpoint(paths); throw error; }
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.uid !== process.getuid?.() || (metadata.mode & 0o077) !== 0) throw new Error("Unsafe control discovery record.");
  const record = JSON.parse(readFileSync(file, "utf8")) as RuntimeRecord;
  const workspaceId = createHash("sha256").update(realpathSync(paths.workspaceRoot)).digest("hex").slice(0, 16);
  if (record.schemaVersion !== 1 || record.role !== "control" || record.workspaceId !== workspaceId || typeof record.endpoint !== "string" || typeof record.instanceId !== "string") throw new Error("Invalid control discovery identity.");
  return { socketPath: record.endpoint, pidPath: getPtyDaemonEndpoint(paths).pidPath };
}
