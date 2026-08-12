import type { RunnerType, TaskRecord } from "../../task/index.js";
import type { CraigActor } from "../types.js";

export type DelegationCommandFamily =
  | "task.create-child"
  | "task.children"
  | "task.cancel-tree"
  | "fury.step.complete"
  | "fury.step.fail"
  | "fury.plan"
  | "fury.run"
  | "fury.cancel"
  | "fury.resume"
  | "fury.review.resubmit";

export interface AgentCapabilityRecord {
  schemaVersion: 1;
  id: string;
  token: string;
  taskId: string;
  agentTabId: string;
  // Persisted command families are extensible so older readers can safely ignore
  // newer names while authorization still requires an exact known family.
  allowedCommandFamilies: string[];
  targetPolicy: "children-only";
  limits: {
    maxChildren: number;
    maxDepth: number;
    maxConcurrentChildren: number;
    maxPromptBytes: number;
  };
  issuedBy: CraigActor;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  revokedBy: CraigActor | null;
}

export interface CreateChildInput {
  parentTaskId: string;
  repoId?: string;
  workspaceId?: string;
  prompt: string;
  runner?: RunnerType;
  idempotencyKey?: string;
  capabilityId?: string;
  fury?: { runId: string; stepId: string };
}

export interface CommandCreateChildResult {
  kind: "createChildTask";
  taskId: string;
  parentTaskId: string;
  rootTaskId: string;
  delegationDepth: number;
  targetType: "repo" | "workspace";
  targetId: string;
  repoId: string;
  workspaceId: string;
  agentTabId: string;
  status: string;
  branch: string;
  worktreePath: string;
  runner: string;
  idempotentReplay: boolean;
}

export interface CommandListChildrenResult {
  kind: "listTaskChildren";
  taskId: string;
  children: TaskRecord[];
}

export interface CancelledTreeTask {
  taskId: string;
  previousStatus: TaskRecord["status"];
  status: TaskRecord["status"];
  disposition: "cancelled" | "already-closed";
}

export interface CommandCancelTreeResult {
  kind: "cancelTaskTree";
  taskId: string;
  cancelled: CancelledTreeTask[];
}
