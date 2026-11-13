import { readPromptCommand, listFuryRuns, listFuryReviews, listFuryPlans } from "../../domain/orchestration/index.js";
import { readdir } from "node:fs/promises";
import path from "node:path";
import type { CraigPaths } from "../../state/craig-paths.js";
import { listTaskCreateOperations } from "../../domain/runtime/task-create/store.js";
import { runtimeIdentity } from "./identity.js";
import { readPrivateRecord, workspaceRuntimeId, type RuntimeRecord } from "./records.js";
import { RuntimeTransport } from "./wire.js";

/** Read-only candidate verification. Never registers a controller or migrates state. */
export async function runtimePreflight(paths: CraigPaths) {
  const workspaceId = await workspaceRuntimeId(paths);
  const files = (await readdir(path.join(paths.runtimeDir, "hosts"))).filter((name) => name.endsWith(".json"));
  if (files.length === 0) throw new Error("Unsupported or missing host generations; replacement blocked.");
  for (const name of files) {
    const record = await readPrivateRecord<RuntimeRecord>(path.join(paths.runtimeDir, "hosts", name));
    if (!record || record.schemaVersion !== 1 || record.role !== "host" || record.workspaceId !== workspaceId || (record.retired !== undefined && typeof record.retired !== "boolean")) throw new Error("Unsupported host discovery version/identity.");
    if (record.retired) continue;
    const transport = await RuntimeTransport.connect(record.endpoint);
    try {
      const hello = await transport.request({ type: "hello", instanceId: record.instanceId, workspaceId, credential: record.credential });
      if (hello.hostProtocol !== 1 || hello.instanceId !== record.instanceId) throw new Error("Unsupported live host protocol; replacement blocked.");
    } finally { transport.close(); }
  }
  // No schema migration is performed. Both replacement and rollback require
  // the same additive durable-state contract, including operation tombstones.
  await listTaskCreateOperations(paths);
  const commands = await readdir(paths.commandsDir).catch((error: unknown) => { if ((error as { code?: string }).code === "ENOENT") return []; throw error; });
  for (const name of commands.filter((name) => name.endsWith(".json"))) await readPromptCommand(paths, name.slice(0, -5));
  await listFuryRuns(paths); await listFuryReviews(paths); await listFuryPlans(paths);
  return { ...runtimeIdentity(), replacementProtocol: 1, durableStateVersions: [1], workspaceId };
}
