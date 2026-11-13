import { logRuntimeEvent } from "./logging.js";
import { resolveRuntimeCompatibility } from "./compatibility.js";
import { execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { CraigPaths } from "../../state/craig-paths.js";
import type { DaemonRestartResult, RuntimeHello } from "../../domain/runtime/types.js";
import { RuntimeTransport } from "./wire.js";
import { pinRuntimeArtifact, verifyRuntimeArtifact } from "./artifacts.js";
import { newRuntimeRecord, readPrivateRecord, writePrivateRecord, workspaceRuntimeId, type RuntimeRecord } from "./records.js";
import { daemonStatus, processAlive } from "./discovery.js";
import { launchRuntimeRole, awaitRuntimeRole, bootstrapSplitRuntime } from "./bootstrap.js";
import { runtimeIdentity } from "./identity.js";
import { acquireRuntimeLock } from "./ownership.js";
import { migrateEmptyLegacy } from "./legacy-transition.js";
const execute = promisify(execFile);
interface ReplacementTransaction {
  schemaVersion: 1;
  id: string;
  state: "prepared" | "released" | "starting" | "ready" | "rolled_back" | "aborted" | "blocked";
  previous: RuntimeRecord;
  targetArtifact: string;
  holdId: string;
  error?: string;
}
export interface ReplacementPorts {
  artifact?: string;
  // Testable lifecycle boundaries; no environment-controlled production faults.
  // eslint-disable-next-line no-unused-vars
  checkpoint?: (stage: "prepared" | "released" | "starting" | "ready" | "rollback", transaction: ReplacementTransaction) => Promise<void>;
}
function parseRelease(version: string | undefined): { numbers: number[]; prerelease: string[] } | null {
  const match = version?.match(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/);
  if (!match) return null;
  const prerelease = match[4]?.split(".") ?? [];
  if (prerelease.some((part) => /^\d+$/.test(part) && part.length > 1 && part.startsWith("0"))) return null;
  return { numbers: match.slice(1, 4).map(Number), prerelease };
}
function stableRelease(version: string | undefined): boolean { const parsed = parseRelease(version); return parsed !== null && parsed.prerelease.length === 0; }
/** Semver order is independent of build metadata; development is incomparable. */
export function compareRuntimeReleases(target: string | undefined, current: string | undefined): number | null {
  const a = parseRelease(target), b = parseRelease(current);
  if (!a || !b) return null;
  for (let index = 0; index < 3; index++) if (a.numbers[index] !== b.numbers[index]) return a.numbers[index]! > b.numbers[index]! ? 1 : -1;
  if (!a.prerelease.length || !b.prerelease.length) return a.prerelease.length === b.prerelease.length ? 0 : a.prerelease.length ? -1 : 1;
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index++) {
    const left = a.prerelease[index], right = b.prerelease[index];
    if (left === right) continue;
    if (left === undefined) return -1;
    if (right === undefined) return 1;
    const leftNumeric = /^\d+$/.test(left), rightNumeric = /^\d+$/.test(right);
    if (leftNumeric && rightNumeric) return BigInt(left) > BigInt(right) ? 1 : -1;
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return left > right ? 1 : -1;
  }
  return 0;
}
async function inspectArtifact(paths: CraigPaths, artifact: string): Promise<RuntimeHello> {
  const manifest = await verifyRuntimeArtifact(artifact);
  const result = await execute(manifest.nodeExecutable, [path.join(artifact, "cli.js"), "__craig-runtime-preflight", paths.workspaceRoot], { cwd: paths.workspaceRoot, env: process.env, timeout: 10000, maxBuffer: 1024 * 1024 });
  const hello = JSON.parse(result.stdout) as RuntimeHello;
  if (hello.workspaceId !== await workspaceRuntimeId(paths) || !resolveRuntimeCompatibility(hello).compatible || hello.replacementProtocol !== 1 || !hello.durableStateVersions?.includes(1) || !hello.buildId || !parseRelease(hello.craigVersion)) throw new Error("Candidate does not support this replacement/durable-state contract.");
  return hello;
}
async function waitForExit(pid: number): Promise<void> {
  const deadline = Date.now() + 10000;
  while (processAlive(pid)) {
    if (Date.now() >= deadline) throw new Error("Control did not release ownership; no process was signalled and no replacement was started.");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** Caller holds lifecycle.lock. Never signals processes or unlinks endpoints. */
export async function replaceControlUnderLock(paths: CraigPaths, explicit = false, ports: ReplacementPorts = {}): Promise<DaemonRestartResult> {
  const status = await daemonStatus(paths);
  const hello = status.runtime;
  const unchanged = (message: string): DaemonRestartResult => ({ kind: "daemonRestart", state: "unchanged", previousBuildId: hello?.buildId ?? null, buildId: hello?.buildId ?? null, message });
  if (!hello?.capabilities?.includes("splitRuntime")) {
    if (!explicit) return unchanged(status.reason ?? "Legacy owner preserved.");
    throw new Error("Legacy sessions/work must finish first. Close every old client, then use craig daemon restart --migrate-legacy for the one-time empty migration.");
  }
  if (status.state !== "ready") throw new Error("Control is not ready; existing ownership preserved.");
  if (!explicit && !ports.artifact && (!stableRelease(runtimeIdentity().craigVersion) || compareRuntimeReleases(runtimeIdentity().craigVersion, hello.craigVersion) !== 1)) return unchanged("Current/newer service retained; equal-release development builds require explicit daemon restart.");
  const artifact = ports.artifact ?? await pinRuntimeArtifact(paths);
  await logRuntimeEvent(paths, "upgrade.requested", { previousBuildId: hello.buildId, explicit });
  const target = await inspectArtifact(paths, artifact);
  const required = hello.capabilities?.filter((capability) => capability !== "splitRuntime" && capability !== "controlReplacement") ?? [];
  if (!resolveRuntimeCompatibility(target, required).compatible) throw new Error("Candidate cannot preserve the current control capabilities; existing service retained.");
  const order = compareRuntimeReleases(target.craigVersion, hello.craigVersion);
  if (order === -1) return unchanged("Newer service retained; downgrade refused.");
  if (!explicit && (!stableRelease(target.craigVersion) || order !== 1 || target.buildId === hello.buildId)) return unchanged("Automatic replacement requires a newer stable release; use explicit restart for equal-release build conflicts.");
  if (hello.replacementProtocol !== 1) throw new Error("Live control has no safe drain contract; existing service and sessions preserved.");
  const file = path.join(paths.runtimeDir, "control.json");
  const previous = await readPrivateRecord<RuntimeRecord>(file);
  if (!previous || previous.instanceId !== hello.instanceId) throw new Error("Control identity changed during preparation.");
  // Rollback compatibility is established before closing admission as well.
  await inspectArtifact(paths, previous.artifact);
  const transaction: ReplacementTransaction = { schemaVersion: 1, id: randomUUID(), state: "prepared", previous, targetArtifact: artifact, holdId: "" };
  transaction.holdId = `upgrade:${transaction.id}`;
  const transactionFile = path.join(paths.runtimeDir, "upgrade.json");
  const save = () => writePrivateRecord(transactionFile, transaction);
  const control = await RuntimeTransport.connect(previous.endpoint);
  const auth = { credential: previous.credential, instanceId: previous.instanceId, workspaceId: previous.workspaceId, transactionId: transaction.id };
  let released = false;
  let commitAttempted = false;
  try {
    await save();
    await control.request({ type: "prepareReplacement", ...auth }, 6500);
    await logRuntimeEvent(paths, "upgrade.draining", { transactionId: transaction.id, instanceId: previous.instanceId });
    await ports.checkpoint?.("prepared", transaction);
    commitAttempted = true;
    await control.request({ type: "commitReplacement", ...auth });
    released = true;
    transaction.state = "released"; await save();
  } catch (error) {
    if (commitAttempted) {
      // A lost commit acknowledgement is resolved by ownership, never by
      // replaying the high-level replacement or killing the old process.
      await waitForExit(previous.pid).catch(() => undefined);
      if (!processAlive(previous.pid)) { released = true; transaction.state = "released"; await save(); }
    }
    if (!released) {
      if (processAlive(previous.pid)) await control.request({ type: "abortReplacement", ...auth }).catch(() => undefined);
      transaction.state = commitAttempted ? "blocked" : "aborted"; transaction.error = String(error); await save();
      throw error;
    }
  } finally { control.close(); }
  await waitForExit(previous.pid);
  await ports.checkpoint?.("released", transaction);
  let child: ChildProcess | undefined;
  let next: RuntimeRecord | undefined;
  try {
    next = await newRuntimeRecord(paths, "control", artifact); next.handoffId = transaction.holdId;
    transaction.state = "starting"; await save();
    await ports.checkpoint?.("starting", transaction);
    child = await launchRuntimeRole(paths, next, file);
    await awaitRuntimeRole(file, child);
    const ready = await daemonStatus(paths);
    if (ready.state !== "ready" || ready.runtime?.buildId !== target.buildId || ready.runtime?.instanceId !== next.instanceId) throw new Error("Replacement readiness identity mismatch.");
    transaction.state = "ready"; await save();
    await logRuntimeEvent(paths, "upgrade.ready", { transactionId: transaction.id, buildId: target.buildId });
    await ports.checkpoint?.("ready", transaction);
    return { kind: "daemonRestart", state: "restarted", previousBuildId: hello.buildId ?? null, buildId: target.buildId!, message: "Control service replaced; agents, PTYs and retained views preserved." };
  } catch (error) {
    transaction.error = String(error);
    // A live/unresponsive candidate cannot be replaced by force. Preserve every
    // host/hold and report unavailable instead of overlapping controllers.
    if (child && child.exitCode === null && child.signalCode === null) {
      transaction.state = "blocked"; await save(); throw new Error(`Candidate still owns startup; rollback blocked without signalling it. ${String(error)}`);
    }
    await inspectArtifact(paths, previous.artifact);
    await ports.checkpoint?.("rollback", transaction);
    const rollback = await newRuntimeRecord(paths, "control", previous.artifact); rollback.handoffId = transaction.holdId;
    const rollbackChild = await launchRuntimeRole(paths, rollback, file);
    await awaitRuntimeRole(file, rollbackChild);
    transaction.state = "rolled_back"; await save();
    await logRuntimeEvent(paths, "upgrade.rollback", { transactionId: transaction.id, buildId: hello.buildId });
    return { kind: "daemonRestart", state: "rolled_back", previousBuildId: hello.buildId ?? null, buildId: hello.buildId ?? null, message: `Replacement failed readiness; compatible previous control restored. ${String(error)}` };
  }
}

/** Recover a lifecycle-manager crash without forcing a live owner out. */
export async function recoverReplacementUnderLock(paths: CraigPaths): Promise<void> {
  const file = path.join(paths.runtimeDir, "upgrade.json");
  const transaction = await readPrivateRecord<ReplacementTransaction>(file);
  if (!transaction || ["ready", "rolled_back", "aborted"].includes(transaction.state)) return;
  if (transaction.schemaVersion !== 1 || !transaction.previous || !transaction.holdId || !transaction.id) throw new Error("Unknown replacement transaction; owners preserved.");
  const current = await readPrivateRecord<RuntimeRecord>(path.join(paths.runtimeDir, "control.json"));
  if (current && processAlive(current.pid)) {
    if (current.instanceId === transaction.previous.instanceId) {
      const transport = await RuntimeTransport.connect(current.endpoint);
      try { await transport.request({ type: "abortReplacement", credential: current.credential, instanceId: current.instanceId, workspaceId: current.workspaceId, transactionId: transaction.id }); }
      finally { transport.close(); }
      transaction.state = "aborted";
    } else {
      const status = await daemonStatus(paths);
      if (status.state !== "ready" || status.runtime?.instanceId !== current.instanceId) throw new Error("Candidate still owns startup; interrupted replacement cannot overlap it.");
      transaction.state = "ready";
    }
    await writePrivateRecord(file, transaction); return;
  }
  await inspectArtifact(paths, transaction.previous.artifact);
  const rollback = await newRuntimeRecord(paths, "control", transaction.previous.artifact); rollback.handoffId = transaction.holdId;
  // A manager can die before acquiring the hold. In that case the old process
  // could not have committed its release; ambiguous ownership blocks here.
  const child = await launchRuntimeRole(paths, rollback, path.join(paths.runtimeDir, "control.json"));
  await awaitRuntimeRole(path.join(paths.runtimeDir, "control.json"), child);
  transaction.state = "rolled_back"; transaction.error = "Recovered interrupted lifecycle transaction with compatible pinned control.";
  await writePrivateRecord(file, transaction);
}

export async function restartDaemon(paths: CraigPaths, migrateLegacy = false): Promise<DaemonRestartResult> {
  if (migrateLegacy) {
    const before = await daemonStatus(paths);
    if (before.state !== "absent" && !before.runtime?.capabilities?.includes("splitRuntime")) {
      await migrateEmptyLegacy(paths, true);
      const after = await daemonStatus(paths);
      return { kind: "daemonRestart", state: "restarted", previousBuildId: before.runtime?.buildId ?? null, buildId: after.runtime?.buildId ?? null, message: "Empty legacy runtime migrated; keep pre-RFC clients closed until this transition completes." };
    }
  }
  const started = Date.now(); let release: (() => Promise<void>) | undefined;
  while (!release) {
    try { release = await acquireRuntimeLock(paths, "lifecycle"); }
    catch (error) { if (Date.now() - started >= 30000) throw error; await new Promise((resolve) => setTimeout(resolve, 50)); }
  }
  try {
    await recoverReplacementUnderLock(paths);
    if ((await daemonStatus(paths)).state === "absent") await bootstrapSplitRuntime(paths);
    return await replaceControlUnderLock(paths, true);
  } catch (error) {
    await logRuntimeEvent(paths, "upgrade.blocked", { reason: "replacement_failed_or_incompatible" }); throw error;
  } finally { await release(); }
}
