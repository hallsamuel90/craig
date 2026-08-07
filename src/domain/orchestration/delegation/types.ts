import type { RunnerType, TaskRecord } from "../../task/index.js";
import type { CraigActor } from "../types.js";

export type DelegationCommandFamily = "task.create-child" | "task.children" | "task.cancel-tree";

export interface AgentCapabilityRecord {
  schemaVersion: 1;
  id: string;
  token: string;
  taskId: string;
  agentTabId: string;
  allowedCommandFamilies: DelegationCommandFamily[];
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
  repoId: string;
  prompt: string;
  runner?: RunnerType;
  idempotencyKey?: string;
  capabilityId?: string;
}

export interface CommandCreateChildResult {
  kind: "createChildTask";
  taskId: string;
  parentTaskId: string;
  rootTaskId: string;
  delegationDepth: number;
  repoId: string;
  workspaceId: string;
  sessionId: string | null;
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
