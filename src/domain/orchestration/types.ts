export type CraigActor =
  | { type: "human"; source: "cli" | "tui"; processId: number }
  | { type: "agent"; taskId: string; agentTabId: string; capabilityId: string }
  | { type: "system"; component: "orchestration-supervisor" | "heartbeat" };

export interface CraigEvent<TType extends string = string, TData = unknown> {
  schemaVersion: 1;
  id: string;
  sequence: number;
  workspaceId: string | null;
  taskId: string | null;
  agentTabId: string | null;
  commandId: string | null;
  swarmRunId: string | null;
  swarmStepId: string | null;
  type: TType;
  occurredAt: string;
  actor: CraigActor;
  data: TData;
}

export interface CraigEventInput<TType extends string = string, TData = unknown> {
  id?: string;
  workspaceId?: string | null;
  taskId?: string | null;
  agentTabId?: string | null;
  commandId?: string | null;
  swarmRunId?: string | null;
  swarmStepId?: string | null;
  type: TType;
  occurredAt?: string;
  actor: CraigActor;
  data: TData;
}

export interface CraigEventFilter {
  taskId?: string;
  typeGlob?: string;
  after?: string;
}

export interface EventCursorInfo {
  after: string | null;
  sequence: number;
  earliestAvailableSequence: number | null;
  latestSequence: number | null;
}

export interface CommandEventListResult {
  kind: "listEvents";
  events: CraigEvent[];
  cursor: EventCursorInfo;
}

export interface CommandEventWatchResult {
  kind: "watchEvents";
  eventCount: number;
  lastSequence: number;
  cancelled: boolean;
}
