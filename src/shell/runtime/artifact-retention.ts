import { randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, realpath, rm } from "node:fs/promises";
import path from "node:path";
import type { CraigPaths } from "../../state/craig-paths.js";
import { getCraigPaths } from "../../state/craig-paths.js";
import { runtimeCacheRoot, verifyRuntimeArtifact } from "./artifacts.js";
import { acquireRuntimeLock } from "./ownership.js";
import { readPrivateRecord, writePrivateRecord, workspaceRuntimeId, type RuntimeRecord } from "./records.js";
import { processAlive } from "./discovery.js";
interface RuntimeOwner { instanceId: string; role: RuntimeRecord["role"]; artifactId: string; file: string; pid: number | null }
interface WorkspaceReference { schemaVersion: 1; workspaceId: string; workspaceRoot: string; registryId?: string; artifacts: string[]; reservations: Array<{ artifactId: string; pid: number }>; owners?: RuntimeOwner[] }
interface ManagedArtifact { schemaVersion: 1; artifactId: string; managed: boolean; registries?: Record<string, string> }
async function privateCacheDirectories(root: string): Promise<void> {
  for (const name of ["references", "managed"]) {
    const directory = path.join(root, name); await mkdir(directory, { recursive: true, mode: 0o700 });
    const metadata = await lstat(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== process.getuid?.() || (metadata.mode & 0o077)) throw new Error("Unsafe artifact registry directory.");
  }
}
const artifactName = /^[a-f0-9]{64}$/;
// eslint-disable-next-line no-unused-vars
export async function withArtifactCacheLock<T>(paths: CraigPaths, work: (root: string) => Promise<T>): Promise<T> {
  const root = await runtimeCacheRoot(); await mkdir(root, { recursive: true, mode: 0o700 });
  const metadata = await lstat(root);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== process.getuid?.() || (metadata.mode & 0o077)) throw new Error("Unsafe artifact cache.");
  await privateCacheDirectories(root);
  const started = Date.now(); let release: (() => Promise<void>) | undefined;
  while (!release) {
    try { release = await acquireRuntimeLock({ ...paths, runtimeDir: root }, "cache"); }
    catch (error) { if (Date.now() - started >= 30000) throw error; await new Promise((resolve) => setTimeout(resolve, 25)); }
  }
  try { return await work(root); } finally { await release(); }
}
/** Called under the per-user lock, before publication returns to the caller. */
export async function reserveArtifactUnderLock(paths: CraigPaths, root: string, artifactId: string, created: boolean): Promise<void> {
  await privateCacheDirectories(root);
  if (!artifactName.test(artifactId)) throw new Error("Invalid artifact reference.");
  const workspaceId = await workspaceRuntimeId(paths);
  const file = path.join(root, "references", `${workspaceId}.json`);
  const previous = await readPrivateRecord<WorkspaceReference>(file);
  const reference: WorkspaceReference = previous ?? { schemaVersion: 1, workspaceId, workspaceRoot: await realpath(paths.workspaceRoot), registryId: randomUUID(), artifacts: [], reservations: [], owners: [] };
  if (!reference.artifacts.includes(artifactId)) reference.artifacts.push(artifactId);
  if (!reference.reservations.some((entry) => entry.artifactId === artifactId && entry.pid === process.pid)) reference.reservations.push({ artifactId, pid: process.pid });
  await writePrivateRecord(file, reference);
  const ledger = path.join(root, "managed", `${artifactId}.json`);
  const managed = await readPrivateRecord<ManagedArtifact>(ledger);
  if (!managed) await writePrivateRecord(ledger, { schemaVersion: 1, artifactId, managed: created, registries: reference.registryId ? { [workspaceId]: reference.registryId } : undefined });
  else if (managed.registries && reference.registryId && !(workspaceId in managed.registries)) await writePrivateRecord(ledger, { ...managed, registries: { ...managed.registries, [workspaceId]: reference.registryId } });
}
export async function releaseArtifactReservationUnderLock(paths: CraigPaths, root: string, artifact: string): Promise<void> {
  const file = path.join(root, "references", `${await workspaceRuntimeId(paths)}.json`);
  const reference = await readPrivateRecord<WorkspaceReference>(file); if (!reference) return;
  reference.reservations = reference.reservations.filter((entry) => entry.artifactId !== path.basename(artifact) || entry.pid !== process.pid);
  await writePrivateRecord(file, reference);
}
/** Journal launch intent before spawning, then its PID, under the publication/GC lock.
 * Missing discovery is never evidence that a published owner has retired. */
export async function recordArtifactOwnerUnderLock(paths: CraigPaths, root: string, record: RuntimeRecord, file: string, pid: number | null): Promise<void> {
  const registry = path.join(root, "references", `${await workspaceRuntimeId(paths)}.json`);
  const reference = await readPrivateRecord<WorkspaceReference>(registry);
  if (!reference || !reference.artifacts.includes(path.basename(record.artifact))) throw new Error("Runtime artifact has no preparation registry.");
  // A pre-ledger reference remains conservative; do not infer its earlier owners.
  if (!reference.owners) return;
  const owner = { instanceId: record.instanceId, role: record.role, artifactId: path.basename(record.artifact), file: path.relative(paths.runtimeDir, file), pid };
  reference.owners = [...reference.owners.filter((entry) => entry.instanceId !== record.instanceId), owner];
  await writePrivateRecord(registry, reference);
}
/** An unlaunched caller can explicitly release only its own preparation pin. */
export async function releaseRuntimeArtifactReservation(paths: CraigPaths, artifact: string): Promise<void> {
  await withArtifactCacheLock(paths, (root) => releaseArtifactReservationUnderLock(paths, root, artifact));
}
async function verifiedWorkspaceArtifacts(reference: WorkspaceReference): Promise<Set<string>> {
  const paths = getCraigPaths(await realpath(reference.workspaceRoot));
  if (reference.schemaVersion !== 1 || reference.workspaceRoot !== paths.workspaceRoot || reference.workspaceId !== await workspaceRuntimeId(paths)) throw new Error("Unverifiable workspace cache reference.");
  for (const directory of [paths.craigDir, paths.runtimeDir, path.join(paths.runtimeDir, "hosts")]) {
    const metadata = await lstat(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== process.getuid?.()) throw new Error("Unverifiable workspace runtime directory.");
  }
  const artifacts = new Set<string>();
  for (const name of ["control.json", "guard.json", ...(await readdir(path.join(paths.runtimeDir, "hosts"))).filter((name) => name.endsWith(".json")).map((name) => path.join("hosts", name))]) {
    const record = await readPrivateRecord<RuntimeRecord>(path.join(paths.runtimeDir, name));
    if (!record) continue;
    if (record.schemaVersion !== 1 || record.workspaceId !== reference.workspaceId || typeof record.artifact !== "string" || !artifactName.test(path.basename(record.artifact)) || !["host", "control", "guard"].includes(record.role) || typeof record.instanceId !== "string" || !Number.isInteger(record.pid) || record.pid <= 0 || (record.retired !== undefined && (typeof record.retired !== "boolean" || record.role !== "host"))) throw new Error("Unknown runtime reference schema.");
    if (record.role !== "host" || !record.retired || processAlive(record.pid)) artifacts.add(path.basename(record.artifact));
  }
  if (!reference.owners) for (const artifact of reference.artifacts) artifacts.add(artifact);
  for (const owner of reference.owners ?? []) {
    if (!artifactName.test(owner.artifactId) || !["host", "control", "guard"].includes(owner.role) || typeof owner.file !== "string" || path.isAbsolute(owner.file) || owner.file.split(path.sep).includes("..") || (owner.pid !== null && (!Number.isInteger(owner.pid) || owner.pid <= 0))) throw new Error("Unknown artifact owner schema.");
    const record = await readPrivateRecord<RuntimeRecord>(path.join(paths.runtimeDir, owner.file));
    const matching = record?.instanceId === owner.instanceId && record.role === owner.role && path.basename(record.artifact) === owner.artifactId && record.pid === owner.pid;
    // Hosts require their own durable retirement marker AND confirmed death.
    // Replaced control/guard owners can be released only after confirmed death;
    // absent discovery (for any role) remains unknown ownership.
    if (!record || owner.pid === null || processAlive(owner.pid) || (owner.role === "host" && (!matching || record.retired !== true))) artifacts.add(owner.artifactId);
  }
  const upgrade = await readPrivateRecord<{ schemaVersion: number; previous: RuntimeRecord; targetArtifact: string }>(path.join(paths.runtimeDir, "upgrade.json"));
  if (upgrade) {
    if (upgrade.schemaVersion !== 1 || !upgrade.previous?.artifact || !upgrade.targetArtifact) throw new Error("Unknown upgrade reference schema.");
    artifacts.add(path.basename(upgrade.previous.artifact)); artifacts.add(path.basename(upgrade.targetArtifact));
  }
  for (const reservation of reference.reservations) if (processAlive(reservation.pid)) artifacts.add(reservation.artifactId);
  return artifacts;
}
/** Never deletes legacy/unregistered artifacts or guesses about missing workspaces. */
export async function collectRuntimeArtifacts(paths: CraigPaths): Promise<{ removed: string[]; retained: string[] }> {
  return withArtifactCacheLock(paths, async (root) => {
    const references = await Promise.all((await readdir(path.join(root, "references")).catch(() => [])).filter((name) => name.endsWith(".json")).map((name) => readPrivateRecord<WorkspaceReference>(path.join(root, "references", name))));
    const needed = new Set<string>(); const unknown = new Set<string>();
    for (const reference of references) {
      if (!reference) throw new Error("Artifact reference disappeared.");
      try { for (const artifact of await verifiedWorkspaceArtifacts(reference)) needed.add(artifact); }
      catch { for (const artifact of reference.artifacts) unknown.add(artifact); }
    }
    const knownRegistries = new Map(references.map((reference) => [reference!.workspaceId, reference!.registryId]));
    const result = { removed: [] as string[], retained: [] as string[] };
    for (const name of (await readdir(root)).filter((name) => artifactName.test(name))) {
      const ledger = await readPrivateRecord<ManagedArtifact>(path.join(root, "managed", `${name}.json`));
      if (!ledger?.managed || !ledger.registries || !Object.keys(ledger.registries).length || Object.entries(ledger.registries).some(([workspaceId, registryId]) => !registryId || knownRegistries.get(workspaceId) !== registryId) || ledger.artifactId !== name || ledger.schemaVersion !== 1 || needed.has(name) || unknown.has(name)) { result.retained.push(name); continue; }
      try { await verifyRuntimeArtifact(path.join(root, name)); } catch { result.retained.push(name); continue; }
      // Launch/pin/publication use this same lock, and all known workspace
      // references were read while it was held. Unknown liveness retains.
      await rm(path.join(root, name), { recursive: true });
      await rm(path.join(root, "managed", `${name}.json`)); result.removed.push(name);
    }
    return result;
  });
}
