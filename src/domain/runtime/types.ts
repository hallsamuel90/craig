export type RuntimeCapability = "terminal" | "activity" | "navigation" | "delegatedLaunch" | "orchestration" | "drainEmpty" | "pullRequestPolling" | "fury";
export interface RuntimeHello {
  protocolVersion?: number;
  sessionCount?: number;
  craigVersion?: string;
  buildId?: string;
  capabilities?: RuntimeCapability[] | undefined;
  lifecycle?: "ready" | "draining";
}
export interface DaemonStatus {
  kind: "daemonStatus";
  schemaVersion: 1;
  state: "absent" | "ready" | "draining" | "reconnecting" | "blocked" | "unavailable";
  runtime: RuntimeHello | null;
  reason: string | null;
  upgradePending: boolean;
}
