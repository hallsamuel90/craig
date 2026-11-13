import { readFile } from "node:fs/promises";
import type { CraigPaths } from "../../state/craig-paths.js";
import { listFuryRuns, listPromptCommands } from "../../domain/orchestration/index.js";
import { getPtyDaemonEndpoint } from "../pty-daemon-protocol.js";
import { resolveRuntimeCompatibility } from "./compatibility.js";
import { acquireRuntimeLock } from "./ownership.js";
import { runtimeRequest, processAlive } from "./discovery.js";
import { bootstrapSplitRuntime } from "./bootstrap.js";

/** One-time migration: the caller must keep every pre-RFC client closed. */
export async function migrateEmptyLegacy(paths: CraigPaths, acknowledgeClosedClients = false): Promise<void> {
  const release = await acquireRuntimeLock(paths, "lifecycle");
  try {
    const endpoint = getPtyDaemonEndpoint(paths);
    const hello = await runtimeRequest(endpoint.socketPath, { type: "ping" });
    if (!hello.ok || !resolveRuntimeCompatibility(hello).compatible || typeof hello.sessionCount !== "number" || hello.sessionCount !== 0) throw new Error("Legacy inventory is live or unverifiable; migration blocked and all sessions preserved.");
    const commands = await listPromptCommands(paths); const runs = await listFuryRuns(paths);
    if (commands.some((command) => command.state === "queued" || command.state === "delivering") || runs.some((run) => run.cleanupPending || !["succeeded", "failed", "cancelled", "timed_out"].includes(run.state))) throw new Error("Background legacy orchestration remains; migration blocked.");
    const bridge = hello.capabilities?.includes("drainEmpty");
    if (!bridge && !acknowledgeClosedClients) throw new Error("Close all old Craig clients and explicitly acknowledge that they will remain closed during this one-time legacy migration.");
    const pid = Number((await readFile(endpoint.pidPath, "utf8")).trim());
    if (!Number.isInteger(pid) || pid <= 0) throw new Error("Legacy process identity is unverifiable; migration blocked.");
    const result = await runtimeRequest(endpoint.socketPath, { type: bridge ? "drainIfEmpty" : "shutdown" });
    if (!result.ok) throw new Error(result.error ?? "Legacy runtime refused empty drain.");
    // No forced termination or timeout cleanup. Guard startup itself verifies
    // dead ownership and aborts if a competing pre-RFC launcher won the bind.
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const owner = await runtimeRequest(endpoint.socketPath, { type: "ping" }).catch(() => null);
      if (!owner && !processAlive(pid)) { await bootstrapSplitRuntime(paths); return; }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("Legacy owner did not exit; migration blocked without signalling or unlinking it.");
  } finally { await release(); }
}
