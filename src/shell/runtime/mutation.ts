import { RuntimeUpgradeRetryError } from "../../domain/runtime/errors.js";
import path from "node:path";
import { readPrivateRecord } from "./records.js";
import { ensureRuntimeRunning } from "./start.js";
import { runtimeMutationContext } from "./mutation-context.js";
import type { CraigPaths } from "../../state/craig-paths.js";
import { daemonStatus } from "./discovery.js";
import { getClientRuntimeEndpoint } from "./endpoint.js";
import { RuntimeTransport } from "./wire.js";

/** Count a domain command through completion, including its durable writes. */
export async function withRuntimeMutation<T>(paths: CraigPaths, work: () => Promise<T>): Promise<T> {
  if (runtimeMutationContext.getStore()) return work();
  const status = await daemonStatus(paths);
  if (!status.runtime && await readPrivateRecord(path.join(paths.runtimeDir, "control.json"))) throw new RuntimeUpgradeRetryError("CRAIG_UPGRADE_RETRY: control is unavailable; mutation was not admitted.");
  if (status.state === "blocked" || status.state === "unavailable" || status.state === "draining") throw new RuntimeUpgradeRetryError(status.reason ?? "Workspace runtime is not accepting mutations; mutation was not admitted.");
  if (!status.runtime?.capabilities?.includes("controlReplacement")) return work();
  if (status.state === "ready") await ensureRuntimeRunning(paths);
  const transport = await RuntimeTransport.connect(getClientRuntimeEndpoint(paths).socketPath);
  try {
    const { token } = await transport.request({ type: "beginMutation" });
    if (typeof token !== "string") throw new Error("Control did not acknowledge mutation admission.");
    try { return await runtimeMutationContext.run(token, work); }
    finally { await transport.request({ type: "endMutation", token }); }
  } finally { transport.close(); }
}
