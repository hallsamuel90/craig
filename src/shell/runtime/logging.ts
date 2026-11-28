import type { CraigPaths } from "../../state/craig-paths.js";
import { errorService } from "../../domain/error/index.js";

/** Lifecycle diagnostics contain safe identities/counts, never terminal input. */
export function logRuntimeEvent(paths: CraigPaths, event: string, details: Record<string, string | number | boolean | null | undefined> = {}): Promise<void> {
  return errorService.appendLogBestEffort(paths, { level: event.endsWith("blocked") || event.endsWith("rejected") ? "warn" : "info", component: "runtime", event, message: event.replaceAll(".", " "), details });
}
