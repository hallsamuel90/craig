import { randomUUID } from "node:crypto";

import type { CraigPaths } from "../../../state/craig-paths.js";
import { CraigError } from "../../error/index.js";
import { appendEvent } from "../events/journal.js";
import type { CraigActor } from "../types.js";
import type {
  CommandCancelPromptResult,
  CommandListPromptsResult,
  CommandSendAgentPromptResult,
  CommandShowPromptResult,
  CommandWaitPromptResult,
  CreatePromptDispatchInput,
  PromptCommandError,
  PromptCommandState,
  PromptDispatch,
} from "./types.js";
import { createPromptCommand, listPromptCommands, mutatePromptCommand, readPromptCommand } from "./store.js";
import { beginPromptDelivery, cancelPromptCommand, completePromptDelivery, failPromptCommand } from "./transitions.js";

export const MAX_PROMPT_BYTES = 32 * 1024;
export const MAX_PROMPT_COMMAND_TIMEOUT_MS = 24 * 60 * 60 * 1_000;
export const MAX_IDEMPOTENCY_KEY_LENGTH = 256;
export const TERMINAL_PROMPT_STATES: PromptCommandState[] = ["delivered", "failed", "cancelled"];
const SUPERVISOR_ACTOR = { type: "system" as const, component: "orchestration-supervisor" as const };

export async function createPromptDispatch(
  paths: CraigPaths,
  input: CreatePromptDispatchInput,
): Promise<CommandSendAgentPromptResult> {
  validatePrompt(input.prompt.text);
  if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs <= 0 || input.timeoutMs > MAX_PROMPT_COMMAND_TIMEOUT_MS) {
    throw new CraigError("CLI_USAGE", "Prompt command timeout must be between 1ms and 24h.", {
      details: { maxTimeoutMs: MAX_PROMPT_COMMAND_TIMEOUT_MS },
    });
  }
  if (input.idempotencyKey !== undefined && input.idempotencyKey !== null && input.idempotencyKey.trim().length === 0) {
    throw new CraigError("CLI_USAGE", "Idempotency key cannot be empty.", {});
  }
  if ((input.idempotencyKey?.length ?? 0) > MAX_IDEMPOTENCY_KEY_LENGTH) {
    throw new CraigError("CLI_USAGE", `Idempotency key exceeds ${MAX_IDEMPOTENCY_KEY_LENGTH} characters.`, {
      details: { maxIdempotencyKeyLength: MAX_IDEMPOTENCY_KEY_LENGTH },
    });
  }
  const now = input.now ?? new Date();
  const command: PromptDispatch = {
    schemaVersion: 1,
    id: input.id ?? `command_${randomUUID()}`,
    idempotencyKey: input.idempotencyKey?.trim() || null,
    taskId: input.taskId,
    agentTabId: input.agentTabId,
    prompt: input.prompt,
    delivery: input.delivery,
    state: "queued",
    attempts: 0,
    timeoutMs: input.timeoutMs,
    expiresAt: new Date(now.getTime() + input.timeoutMs).toISOString(),
    lastError: null,
    actor: input.actor,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    deliveryStartedAt: null,
    deliveredAt: null,
    cancelledAt: null,
    cancelledBy: null,
  };
  const persisted = await createPromptCommand(paths, command);
  if (persisted.created) {
    try {
      await appendPromptCommandEvent(paths, persisted.command, "command.queued");
    } catch (error) {
      throw partialEventResult(persisted.command, error);
    }
  }
  return { kind: "sendAgentPrompt", ...persisted };
}

export async function showPromptDispatch(paths: CraigPaths, commandId: string): Promise<CommandShowPromptResult> {
  return { kind: "showPromptCommand", command: await readPromptCommand(paths, commandId) };
}

export async function listPromptDispatches(paths: CraigPaths, taskId?: string): Promise<CommandListPromptsResult> {
  const commands = await listPromptCommands(paths);
  return { kind: "listPromptCommands", commands: taskId ? commands.filter((command) => command.taskId === taskId) : commands };
}

export async function cancelPromptDispatch(
  paths: CraigPaths,
  commandId: string,
  actor?: CraigActor,
): Promise<CommandCancelPromptResult> {
  let changed = false;
  const command = await mutatePromptCommand(paths, commandId, (current) => {
    if (current.state === "cancelled") return current;
    const next = cancelPromptCommand(current, actor ?? current.actor);
    changed = true;
    return next;
  });
  if (changed) {
    try {
      await appendPromptCommandEvent(paths, command, "command.cancelled", command.cancelledBy ?? command.actor);
    } catch (error) {
      throw partialEventResult(command, error);
    }
  }
  return { kind: "cancelPromptCommand", command, changed };
}

export async function beginDelivery(paths: CraigPaths, commandId: string): Promise<PromptDispatch> {
  const command = await mutatePromptCommand(paths, commandId, (current) => beginPromptDelivery(current));
  await appendPromptCommandEvent(paths, command, "command.delivering", SUPERVISOR_ACTOR);
  return command;
}

export async function completeDelivery(paths: CraigPaths, commandId: string): Promise<PromptDispatch> {
  const command = await mutatePromptCommand(paths, commandId, (current) => completePromptDelivery(current));
  await appendPromptCommandEvent(paths, command, "command.delivered", SUPERVISOR_ACTOR);
  return command;
}

export async function failDispatch(
  paths: CraigPaths,
  commandId: string,
  error: PromptCommandError,
): Promise<PromptDispatch> {
  const command = await mutatePromptCommand(paths, commandId, (current) => failPromptCommand(current, error));
  await appendPromptCommandEvent(paths, command, "command.failed", SUPERVISOR_ACTOR);
  return command;
}

export async function waitForPromptDispatch(
  paths: CraigPaths,
  commandId: string,
  options: { states?: readonly PromptCommandState[]; timeoutMs: number; signal?: AbortSignal; pollIntervalMs?: number },
): Promise<CommandWaitPromptResult> {
  const states = [...(options.states ?? TERMINAL_PROMPT_STATES)];
  const deadline = Date.now() + options.timeoutMs;
  while (true) {
    const command = await readPromptCommand(paths, commandId);
    if (states.includes(command.state)) return { kind: "waitPromptCommand", command, matchedStates: states };
    if (options.signal?.aborted) {
      throw new CraigError("OPERATION_CANCELLED", `Cancelled while waiting for command ${commandId}.`, {
        retryable: true,
        details: { commandId, cancelled: true },
      });
    }
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw new CraigError("OPERATION_TIMEOUT", `Timed out after ${options.timeoutMs}ms waiting for command ${commandId}.`, {
        retryable: true,
        details: { commandId, states, timeoutMs: options.timeoutMs },
      });
    }
    await wait(Math.min(options.pollIntervalMs ?? 100, remainingMs), options.signal);
  }
}

function validatePrompt(prompt: string): void {
  if (prompt.trim().length === 0) throw new CraigError("CLI_USAGE", "Prompt cannot be empty.", {});
  const bytes = Buffer.byteLength(prompt);
  if (bytes > MAX_PROMPT_BYTES) {
    throw new CraigError("CLI_USAGE", `Prompt exceeds the ${MAX_PROMPT_BYTES}-byte limit.`, {
      details: { maxPromptBytes: MAX_PROMPT_BYTES, promptBytes: bytes },
    });
  }
  if ([...prompt].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 8 || (code >= 11 && code <= 31) || (code >= 127 && code <= 159);
  })) {
    throw new CraigError("CLI_USAGE", "Prompt contains unsupported control characters.", {});
  }
}

export async function appendPromptCommandEvent(
  paths: CraigPaths,
  command: PromptDispatch,
  type: string,
  actor: CraigActor = command.actor,
): Promise<void> {
  await appendEvent(paths, {
    id: `${command.id}:${type}`,
    taskId: command.taskId,
    agentTabId: command.agentTabId,
    commandId: command.id,
    type,
    occurredAt: type === "command.queued"
      ? command.createdAt
      : type === "command.delivering"
        ? command.deliveryStartedAt ?? command.updatedAt
        : type === "command.delivered"
          ? command.deliveredAt ?? command.updatedAt
          : type === "command.cancelled"
            ? command.cancelledAt ?? command.updatedAt
            : command.updatedAt,
    actor,
    data: {
      state: command.state,
      delivery: command.delivery,
      attempts: command.attempts,
      errorCode: command.lastError?.code ?? null,
      deliveryUncertain: command.lastError?.deliveryUncertain ?? false,
    },
  });
}

function wait(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    signal?.addEventListener("abort", finish, { once: true });
  });
}

const partialEventResult = (command: PromptDispatch, cause: unknown) => new CraigError(
  "PARTIAL_RESULT",
  `Command ${command.id} was persisted as ${command.state}, but its event could not be appended.`,
  {
    retryable: true,
    details: { commandId: command.id, durableState: command.state },
    cause,
  },
);

export const promptCommandService = {
  create: createPromptDispatch,
  show: showPromptDispatch,
  list: listPromptDispatches,
  cancel: cancelPromptDispatch,
  wait: waitForPromptDispatch,
  beginDelivery,
  completeDelivery,
  fail: failDispatch,
};
