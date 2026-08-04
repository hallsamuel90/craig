import { CraigError } from "../../error/index.js";
import type { PromptCommandError, PromptCommandState, PromptDispatch } from "./types.js";

export function beginPromptDelivery(command: PromptDispatch, now = new Date()): PromptDispatch {
  requireState(command, ["queued"], "begin delivery");
  return {
    ...command,
    state: "delivering",
    attempts: command.attempts + 1,
    lastError: null,
    deliveryStartedAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
}

export function completePromptDelivery(command: PromptDispatch, now = new Date()): PromptDispatch {
  if (command.state === "delivered") return command;
  requireState(command, ["delivering"], "complete delivery");
  return {
    ...command,
    state: "delivered",
    deliveredAt: now.toISOString(),
    lastError: null,
    updatedAt: now.toISOString(),
  };
}

export function failPromptCommand(
  command: PromptDispatch,
  error: PromptCommandError,
  now = new Date(),
): PromptDispatch {
  if (command.state === "failed") return command;
  requireState(command, ["queued", "delivering"], "fail");
  return { ...command, state: "failed", lastError: error, updatedAt: now.toISOString() };
}

export function cancelPromptCommand(
  command: PromptDispatch,
  actor: PromptDispatch["actor"],
  now = new Date(),
): PromptDispatch {
  if (command.state === "cancelled") return command;
  requireState(command, ["queued"], "cancel");
  return {
    ...command,
    state: "cancelled",
    cancelledAt: now.toISOString(),
    cancelledBy: actor,
    updatedAt: now.toISOString(),
  };
}

function requireState(command: PromptDispatch, allowed: PromptCommandState[], action: string): void {
  if (allowed.includes(command.state)) return;
  throw new CraigError(
    "COMMAND_STATE_CONFLICT",
    `Cannot ${action} command ${command.id} while it is ${command.state}.`,
    { details: { commandId: command.id, state: command.state, allowedStates: allowed } },
  );
}
