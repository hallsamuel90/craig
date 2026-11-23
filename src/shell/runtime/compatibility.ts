import type { RuntimeCapability, RuntimeHello } from "../../domain/runtime/types.js";

// Profiles describe requests actually implemented by the pre-lifecycle daemons.
// Protocol 0 is a successful legacy ping that must never authorize startup.
export const LEGACY_REJECTION_PROTOCOL = 0;
export const LEGACY_PROFILES: Readonly<Record<number, readonly RuntimeCapability[]>> = {
  6: ["terminal", "activity", "delegatedLaunch"],
  7: ["terminal", "activity", "delegatedLaunch", "orchestration"],
  8: ["terminal", "activity", "delegatedLaunch", "orchestration", "pullRequestPolling"],
  9: ["terminal", "activity", "delegatedLaunch", "orchestration", "pullRequestPolling"],
  10: ["terminal", "activity", "delegatedLaunch", "orchestration", "pullRequestPolling", "navigation"],
};
export const RUNTIME_CAPABILITIES: RuntimeCapability[] = [...LEGACY_PROFILES[10]!, "drainEmpty", "fury", "ghosttyTerminal"];
export const UPGRADE_PENDING_MESSAGE = "Existing sessions are preserved on the previous runtime. Some updated features will be available after those sessions finish.";

export function resolveRuntimeCompatibility(hello: RuntimeHello, required: RuntimeCapability[] = [], local?: RuntimeHello): { compatible: boolean; upgradePending: boolean; reason: string | null } {
  if (hello.capabilities !== undefined && (!Array.isArray(hello.capabilities) || !hello.capabilities.every((capability) => typeof capability === "string"))) {
    return { compatible: false, upgradePending: true, reason: "Malformed runtime capabilities; existing runtime preserved." };
  }
  if (hello.lifecycle !== undefined && !["ready", "draining"].includes(hello.lifecycle)) return { compatible: false, upgradePending: true, reason: "Unknown runtime lifecycle; existing runtime preserved." };
  const profile = Number.isInteger(hello.protocolVersion) ? LEGACY_PROFILES[hello.protocolVersion!] : undefined;
  if (!profile) return { compatible: false, upgradePending: true, reason: "Use an updated Craig binary; the live workspace runtime is incompatible. This client will not replace a live workspace daemon." };
  const capabilities = [...(hello.capabilities ?? profile), ...(hello.ghosttyTerminal === true ? ["ghosttyTerminal" as const] : [])];
  const missing = required.filter((capability) => !capabilities.includes(capability));
  if (missing.length) return { compatible: false, upgradePending: true, reason: `${UPGRADE_PENDING_MESSAGE} Missing capabilities: ${missing.join(", ")}.` };
  const conflict = Boolean(local?.buildId && hello.buildId && local.buildId !== hello.buildId && local.craigVersion === hello.craigVersion);
  const upgradePending = !hello.buildId || conflict || Boolean(local?.buildId && hello.buildId !== local.buildId);
  return { compatible: true, upgradePending, reason: conflict ? `${UPGRADE_PENDING_MESSAGE} Equal-version build conflict; automatic replacement is disabled.` : upgradePending ? UPGRADE_PENDING_MESSAGE : null };
}

export function requireRuntimeCapabilities(hello: RuntimeHello, required: RuntimeCapability[]): void {
  const decision = resolveRuntimeCompatibility(hello, required);
  if (!decision.compatible) throw new Error(decision.reason!);
}
