import { logRuntimeEvent } from "./logging.js";
import { withArtifactCacheLock, recordArtifactOwnerUnderLock, releaseArtifactReservationUnderLock, collectRuntimeArtifacts } from "./artifact-retention.js";
import { listTaskCreateOperations } from "../../domain/runtime/task-create/store.js";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, readdir, open } from "node:fs/promises";
import path from "node:path";
import { getCraigPaths, type CraigPaths } from "../../state/craig-paths.js";
import { getPtyDaemonEndpoint } from "../pty-daemon-protocol.js";
import { RuntimeTransport } from "./wire.js";
import { runtimeRequest, processAlive } from "./discovery.js";
import { pinRuntimeArtifact, verifyRuntimeArtifact } from "./artifacts.js";
import { newRuntimeRecord, readPrivateRecord, writePrivateRecord, privateRuntimeDirectory, workspaceRuntimeId, type RuntimeRecord } from "./records.js";

export async function launchRuntimeRole(paths: CraigPaths, record: RuntimeRecord, file: string) {
  return withArtifactCacheLock(paths, async (root) => {
  const manifest = await verifyRuntimeArtifact(record.artifact);
  await recordArtifactOwnerUnderLock(paths, root, record, file, null);
  await writePrivateRecord(file, record);
  const log = await open(path.join(paths.runtimeDir, `${record.role}.log`), "a", 0o600);
  try {
    const child = spawn(manifest.nodeExecutable, [path.join(record.artifact, "cli.js"), "__craig-runtime-role", record.role, paths.workspaceRoot, file], { cwd: paths.workspaceRoot, detached: true, stdio: ["ignore", log.fd, log.fd], env: process.env });
    child.unref();
    if (child.pid) await recordArtifactOwnerUnderLock(paths, root, record, file, child.pid);
    await releaseArtifactReservationUnderLock(paths, root, record.artifact);
    return child;
  } finally { await log.close(); }
  });
}
async function verifiedRole(record: RuntimeRecord): Promise<boolean> {
  let transport: RuntimeTransport | undefined;
  try {
    if (record.role === "host") {
      transport = await RuntimeTransport.connect(record.endpoint);
      const response = await transport.request({ type: "hello", credential: record.credential, workspaceId: record.workspaceId, instanceId: record.instanceId });
      return response.instanceId === record.instanceId && response.hostProtocol === 1;
    }
    const response = await runtimeRequest(record.endpoint, { type: "ping" });
    return response.ok && (response as { instanceId?: unknown }).instanceId === record.instanceId && (record.role !== "control" || (record.ready && response.lifecycle === "ready"));
  } catch { return false; }
  finally { transport?.close(); }
}
export async function awaitRuntimeRole(file: string, child?: ChildProcess): Promise<RuntimeRecord> {
  const started = Date.now();
  while (Date.now() - started < 10000) {
    if (child && (child.exitCode !== null || child.signalCode !== null)) throw new Error("Candidate control exited before readiness.");
    const record = await readPrivateRecord<RuntimeRecord>(file);
    if (record && await verifiedRole(record)) {
      if (record.role === "host") await logRuntimeEvent(getCraigPaths(path.resolve(path.dirname(file), "../../..")), "host.started", { instanceId: record.instanceId, pid: record.pid, hostRevision: record.hostRevision });
      return record;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Runtime role failed readiness; existing sessions preserved (${path.basename(file)}).`);
}

/** Caller holds the workspace lifecycle lock. Never replaces a living owner. */
export async function bootstrapSplitRuntime(paths: CraigPaths): Promise<void> {
  await mkdir(paths.runtimeDir, { recursive: true, mode: 0o700 });
  const controlPath = path.join(paths.runtimeDir, "control.json");
  const previous = await readPrivateRecord<RuntimeRecord>(controlPath);
  const guardPath = path.join(paths.runtimeDir, "guard.json");
  let guard = await readPrivateRecord<RuntimeRecord>(guardPath);
  const artifact = previous?.artifact ?? await pinRuntimeArtifact(paths);
  if (!guard || !await verifiedRole(guard)) {
    if (guard && processAlive(guard.pid)) throw new Error("Compatibility guard is alive but unverifiable; mutations blocked.");
    const legacy = await runtimeRequest(getPtyDaemonEndpoint(paths).socketPath, { type: "ping" }).catch(() => null);
    if (legacy) throw new Error("A legacy owner won startup; migration aborted and its sessions preserved.");
    guard = await newRuntimeRecord(paths, "guard", artifact);
    guard.endpoint = getPtyDaemonEndpoint(paths).socketPath;
    await launchRuntimeRole(paths, guard, guardPath); guard = await awaitRuntimeRole(guardPath);
  }
  if (!await verifiedRole(guard)) throw new Error("Guard is not ready; split runtime must not launch sessions.");
  if (previous && processAlive(previous.pid)) {
    if (await verifiedRole(previous)) return;
    throw new Error("The living control owner is unavailable; it will not be replaced.");
  }
  const hostDirectory = path.join(paths.runtimeDir, "hosts");
  await mkdir(hostDirectory, { recursive: true, mode: 0o700 });
  const hostFiles = (await readdir(hostDirectory)).filter((name) => name.endsWith(".json"));
  let host: RuntimeRecord | null = null;
  for (const name of hostFiles) {
    const record = await readPrivateRecord<RuntimeRecord>(path.join(hostDirectory, name));
    if (!record || record.schemaVersion !== 1 || record.role !== "host" || record.workspaceId !== await workspaceRuntimeId(paths) || (record.retired !== undefined && typeof record.retired !== "boolean")) throw new Error("Host discovery identity is unverifiable.");
    if (record.retired) continue;
    if (!record || !await verifiedRole(record)) throw new Error("A recorded session host is unavailable; do not recreate its sessions.");
    host = record;
  }
  if (!host && hostFiles.length === 0) {
    const endpoints = await readdir(await privateRuntimeDirectory(paths));
    if (previous || endpoints.some((name) => name.startsWith("host-")) || (await listTaskCreateOperations(paths)).length > 0) throw new Error("Host discovery is missing or unverifiable; existing sessions must not be recreated.");
    host = await newRuntimeRecord(paths, "host", artifact);
    const file = path.join(hostDirectory, `${host.instanceId}.json`);
    await launchRuntimeRole(paths, host, file); host = await awaitRuntimeRole(file);
  }
  const control = await newRuntimeRecord(paths, "control", artifact);
  await launchRuntimeRole(paths, control, controlPath);
  await awaitRuntimeRole(controlPath);
  await collectRuntimeArtifacts(paths);
}

/** Explicit fixture/user runtime termination. This is never called by upgrades. */
export async function shutdownSplitRuntime(paths: CraigPaths): Promise<boolean> {
  const control = await readPrivateRecord<RuntimeRecord>(path.join(paths.runtimeDir, "control.json"));
  if (!control) return false;
  if ((await listTaskCreateOperations(paths)).some((operation) => operation.state !== "completed" && operation.state !== "failed")) throw new Error("Pending task-create recovery retains the workspace guard.");
  if (processAlive(control.pid)) {
    const transport = await RuntimeTransport.connect(control.endpoint);
    try { await transport.request({ type: "shutdownWorkspace" }, 10000); }
    finally { transport.close(); }
  }
  const guard = await readPrivateRecord<RuntimeRecord>(path.join(paths.runtimeDir, "guard.json"));
  if (!guard) throw new Error("Guard discovery is missing; cannot verify shutdown.");
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const transport = await RuntimeTransport.connect(guard.endpoint);
    try { await transport.request({ type: "shutdownGuard", credential: guard.credential, instanceId: guard.instanceId, workspaceId: guard.workspaceId }); return true; }
    catch { await new Promise((resolve) => setTimeout(resolve, 50)); }
    finally { transport.close(); }
  }
  throw new Error("Runtime still owns sessions or control work; guard retained.");
}
