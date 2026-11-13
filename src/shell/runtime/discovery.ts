import { runtimeMutationContext } from "./mutation-context.js";
import path from "node:path";
import { readPrivateRecord, workspaceRuntimeId, type RuntimeRecord } from "./records.js";
import { getClientRuntimeEndpoint } from "./endpoint.js";
import { createConnection } from "node:net";
import { lstat, readFile } from "node:fs/promises";
import type { CraigPaths } from "../../state/craig-paths.js";
import type { DaemonStatus, RuntimeHello, RuntimeCapability } from "../../domain/runtime/types.js";
import { requireRuntimeCapabilities, resolveRuntimeCompatibility } from "./compatibility.js";
import { runtimeIdentity } from "./identity.js";

export function runtimeRequest(socketPath: string, input: Record<string, unknown>): Promise<RuntimeHello & { ok: boolean; error?: string }> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let buffer = "";
    const timeout = setTimeout(() => finish(new Error("Workspace runtime is unresponsive; its owner is preserved.")), 750);
    const finish = (error?: Error, value?: RuntimeHello & { ok: boolean }) => {
      clearTimeout(timeout);
      socket.destroy();
      if (error) reject(error); else resolve(value!);
    };
    socket.on("error", (error) => finish(error));
    socket.on("connect", () => socket.write(`${JSON.stringify({ ...input, id: 1 })}\n`));
    socket.on("data", (chunk) => {
      buffer += String(chunk);
      if (!buffer.includes("\n")) return;
      try { finish(undefined, JSON.parse(buffer.slice(0, buffer.indexOf("\n")))); }
      catch { finish(new Error("Malformed runtime response.")); }
    });
    socket.on("end", () => { if (!buffer.includes("\n")) finish(new Error("Runtime disconnected before responding.")); });
  });
}
export function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return true; // Unknown identity cannot authorize takeover.
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as Error & { code?: string }).code !== "ESRCH"; }
}
export async function daemonStatus(paths: CraigPaths): Promise<DaemonStatus> {
  const endpoint = getClientRuntimeEndpoint(paths);
  const base = { kind: "daemonStatus" as const, schemaVersion: 1 as const };
  try {
    const hello = await runtimeRequest(endpoint.socketPath, { type: "ping" });
    if (!hello.ok) throw new Error(hello.error ?? "Runtime rejected discovery.");
    await validateWorkspaceRuntimeIdentity(paths, hello);
    const decision = resolveRuntimeCompatibility(hello, [], runtimeIdentity());
    return { ...base, state: decision.compatible ? hello.lifecycle ?? "ready" : "blocked", runtime: hello, reason: decision.reason, upgradePending: decision.upgradePending };
  } catch (error) {
    const pidText = await readFile(endpoint.pidPath, "utf8").catch(() => null);
    const socket = await lstat(endpoint.socketPath).catch(() => null);
    const pid = Number(pidText?.trim());
    const refused = ["ECONNREFUSED", "ENOENT"].includes((error as Error & { code?: string }).code ?? "");
    const ambiguous = (socket !== null && !refused) || (pidText !== null && (!Number.isInteger(pid) || pid <= 0 || processAlive(pid)));
    return { ...base, state: ambiguous ? "unavailable" : "absent", runtime: null, reason: ambiguous ? (error as Error).message : null, upgradePending: false };
  }
}

/** Preflight only; phase 2 admission must still cover provisioning through launch. */
export async function requireAvailableRuntimeCapabilities(paths: CraigPaths, required: RuntimeCapability[]): Promise<string | null> {
  const status = await daemonStatus(paths);
  if (status.state === "absent") return null;
  if ((status.state !== "ready" && !(status.state === "draining" && runtimeMutationContext.getStore())) || !status.runtime) throw new Error(status.reason ?? "Workspace runtime is not accepting mutations; existing sessions are preserved.");
  const decision = resolveRuntimeCompatibility(status.runtime, required, runtimeIdentity());
  if (!decision.compatible) throw new Error(decision.reason!);
  return decision.reason;
}

export async function validateWorkspaceRuntimeIdentity(paths: CraigPaths, hello: RuntimeHello): Promise<void> {
  const expected = await workspaceRuntimeId(paths);
  if (hello.workspaceId !== undefined && hello.workspaceId !== expected) throw new Error("Runtime belongs to another workspace; owner preserved.");
  const control = await readPrivateRecord<RuntimeRecord>(path.join(paths.runtimeDir, "control.json"));
  if (control && (hello.role !== "control" || hello.instanceId !== control.instanceId || hello.workspaceId !== expected)) throw new Error("Control instance discovery does not match its live endpoint; owner preserved.");
}
export async function requireWorkspaceRuntimeCapabilities(paths: CraigPaths, hello: RuntimeHello, required: RuntimeCapability[]): Promise<void> {
  await validateWorkspaceRuntimeIdentity(paths, hello);
  requireRuntimeCapabilities(hello, required);
}
