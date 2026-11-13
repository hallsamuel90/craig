export type RuntimeCapability = "terminal" | "activity" | "navigation" | "delegatedLaunch" | "orchestration" | "drainEmpty" | "pullRequestPolling" | "fury" | "splitRuntime";
export interface RuntimeHello {
  protocolVersion?: number;
  role?: string;
  workspaceId?: string;
  instanceId?: string;
  sessionCount?: number;
  craigVersion?: string;
  buildId?: string;
  capabilities?: RuntimeCapability[] | undefined;
  hosts?: Array<{ instanceId: string; pid: number; hostRevision: string; sessionCount: number; retainedViewCount: number; pendingCreates: number; handoffHoldCount: number }>;
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
