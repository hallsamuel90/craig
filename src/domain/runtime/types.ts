export type RuntimeCapability = "terminal" | "activity" | "navigation" | "delegatedLaunch" | "orchestration" | "drainEmpty" | "pullRequestPolling" | "fury" | "splitRuntime" | "controlReplacement" | "ghosttyTerminal";
export interface RuntimeHello {
  protocolVersion?: number;
  ghosttyTerminal?: boolean;
  replacementProtocol?: number;
  durableStateVersions?: number[];
  pendingMutations?: number;
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

export interface DaemonRestartResult {
  kind: "daemonRestart";
  state: "restarted" | "unchanged" | "rolled_back";
  previousBuildId: string | null;
  buildId: string | null;
  message: string;
}
