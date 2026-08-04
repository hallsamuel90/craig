import type { CraigActor } from "../types.js";

export type PromptDelivery = "when-ready" | "immediate";
export type PromptCommandState = "queued" | "delivering" | "delivered" | "failed" | "cancelled";
export type PromptCommandTerminalState = Extract<PromptCommandState, "delivered" | "failed" | "cancelled">;

export interface PromptCommandError {
  code: string;
  message: string;
  retryable: boolean;
  deliveryUncertain: boolean;
}

export interface PromptDispatch {
  schemaVersion: 1;
  id: string;
  idempotencyKey: string | null;
  taskId: string;
  agentTabId: string;
  prompt: {
    source: "inline" | "file" | "stdin";
    text: string;
  };
  delivery: PromptDelivery;
  state: PromptCommandState;
  attempts: number;
  timeoutMs: number;
  expiresAt: string;
  lastError: PromptCommandError | null;
  actor: CraigActor;
  createdAt: string;
  updatedAt: string;
  deliveryStartedAt: string | null;
  deliveredAt: string | null;
  cancelledAt: string | null;
  cancelledBy: CraigActor | null;
}

export interface CreatePromptDispatchInput {
  id?: string;
  idempotencyKey?: string | null;
  taskId: string;
  agentTabId: string;
  prompt: PromptDispatch["prompt"];
  delivery: PromptDelivery;
  timeoutMs: number;
  actor: CraigActor;
  now?: Date;
}

export interface CommandSendAgentPromptResult {
  kind: "sendAgentPrompt";
  command: PromptDispatch;
  created: boolean;
}

export interface CommandShowPromptResult {
  kind: "showPromptCommand";
  command: PromptDispatch;
}

export interface CommandListPromptsResult {
  kind: "listPromptCommands";
  commands: PromptDispatch[];
}

export interface CommandCancelPromptResult {
  kind: "cancelPromptCommand";
  command: PromptDispatch;
  changed: boolean;
}

export interface CommandWaitPromptResult {
  kind: "waitPromptCommand";
  command: PromptDispatch;
  matchedStates: PromptCommandState[];
}
