import { mkdir, readdir, readFile } from "node:fs/promises";
import path from "node:path";

import type { CraigPaths } from "../../../state/craig-paths.js";
import { atomicWriteJson } from "../../../shared/atomic-write.js";
import { CraigError } from "../../error/index.js";
import { withCommandStoreLock } from "../adapters/command-lock.js";
import type { PromptCommandError, PromptCommandState, PromptDispatch } from "./types.js";

export async function readPromptCommand(paths: CraigPaths, commandId: string): Promise<PromptDispatch> {
  assertCommandId(commandId);
  try {
    const raw = JSON.parse(await readFile(commandPath(paths, commandId), "utf8")) as unknown;
    return validatePromptCommand(raw, commandPath(paths, commandId), commandId);
  } catch (error) {
    if (isMissing(error)) {
      throw new CraigError("COMMAND_NOT_FOUND", `Craig command "${commandId}" was not found.`, {
        details: { commandId },
      });
    }
    if (error instanceof SyntaxError) {
      throw invalidRecord(commandId, commandPath(paths, commandId), error);
    }
    throw error;
  }
}

export async function listPromptCommands(paths: CraigPaths): Promise<PromptDispatch[]> {
  await mkdir(paths.commandsDir, { recursive: true });
  const names = await readdir(paths.commandsDir);
  const commands: PromptDispatch[] = [];
  for (const name of names.filter((value) => value.endsWith(".json")).sort()) {
    const filePath = path.join(paths.commandsDir, name);
    try {
      commands.push(validatePromptCommand(
        JSON.parse(await readFile(filePath, "utf8")) as unknown,
        filePath,
        name.slice(0, -5),
      ));
    } catch (error) {
      if (error instanceof CraigError) throw error;
      throw invalidRecord(name.slice(0, -5), filePath, error);
    }
  }
  return commands.sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
}

export async function createPromptCommand(
  paths: CraigPaths,
  command: PromptDispatch,
): Promise<{ command: PromptDispatch; created: boolean }> {
  assertCommandId(command.id);
  return withCommandStoreLock(paths, async () => {
    await mkdir(paths.commandsDir, { recursive: true });
    const commands = await listPromptCommands(paths);
    if (command.idempotencyKey) {
      const existing = commands.find((candidate) => candidate.idempotencyKey === command.idempotencyKey);
      if (existing) {
        if (!hasSameIntent(existing, command)) {
          throw new CraigError(
            "COMMAND_STATE_CONFLICT",
            `Idempotency key "${command.idempotencyKey}" is already used by command ${existing.id}.`,
            { details: { commandId: existing.id, idempotencyKey: command.idempotencyKey } },
          );
        }
        return { command: existing, created: false };
      }
    }
    await atomicWriteJson(commandPath(paths, command.id), command);
    return { command, created: true };
  });
}

export async function mutatePromptCommand(
  paths: CraigPaths,
  commandId: string,
  /* eslint-disable-next-line no-unused-vars */
  mutation: (command: PromptDispatch) => PromptDispatch,
): Promise<PromptDispatch> {
  assertCommandId(commandId);
  return withCommandStoreLock(paths, async () => {
    const current = await readPromptCommand(paths, commandId);
    const next = mutation(current);
    if (next.id !== current.id) {
      throw new CraigError("INTERNAL_ERROR", "Command mutation cannot change its id.", {});
    }
    await atomicWriteJson(commandPath(paths, commandId), next);
    return next;
  });
}

function hasSameIntent(left: PromptDispatch, right: PromptDispatch): boolean {
  return left.taskId === right.taskId &&
    left.agentTabId === right.agentTabId &&
    left.prompt.source === right.prompt.source &&
    left.prompt.text === right.prompt.text &&
    left.delivery === right.delivery &&
    left.timeoutMs === right.timeoutMs;
}

function validatePromptCommand(value: unknown, filePath: string, expectedId: string): PromptDispatch {
  if (!isObject(value) || value.schemaVersion !== 1 || typeof value.id !== "string" || value.id.length === 0) {
    throw invalidRecord("unknown", filePath);
  }
  const commandId = value.id;
  const states: PromptCommandState[] = ["queued", "delivering", "delivered", "failed", "cancelled"];
  if (
    commandId !== expectedId ||
    (value.idempotencyKey !== null && (typeof value.idempotencyKey !== "string" || value.idempotencyKey.length > 256)) ||
    typeof value.taskId !== "string" || value.taskId.length === 0 ||
    typeof value.agentTabId !== "string" || value.agentTabId.length === 0 ||
    !isObject(value.prompt) || !["inline", "file", "stdin"].includes(String(value.prompt.source)) ||
    typeof value.prompt.text !== "string" || !isSafePersistedPrompt(value.prompt.text) ||
    !["when-ready", "immediate"].includes(String(value.delivery)) ||
    !states.includes(value.state as PromptCommandState) ||
    !Number.isInteger(value.attempts) || Number(value.attempts) < 0 ||
    !Number.isInteger(value.timeoutMs) || Number(value.timeoutMs) <= 0 || Number(value.timeoutMs) > 86_400_000 ||
    !isTimestamp(value.expiresAt) || !isTimestamp(value.createdAt) ||
    !isTimestamp(value.updatedAt) ||
    (value.deliveryStartedAt !== null && !isTimestamp(value.deliveryStartedAt)) ||
    (value.deliveredAt !== null && !isTimestamp(value.deliveredAt)) ||
    (value.cancelledAt !== null && !isTimestamp(value.cancelledAt)) ||
    (value.cancelledBy !== null && !isActor(value.cancelledBy)) ||
    !isActor(value.actor) || !isCommandError(value.lastError) ||
    (value.state === "delivered") !== (value.deliveredAt !== null) ||
    (value.state === "failed") !== (value.lastError !== null) ||
    (Number(value.attempts) > 0) !== (value.deliveryStartedAt !== null) ||
    (value.state === "cancelled") !== (value.cancelledAt !== null && value.cancelledBy !== null)
  ) {
    throw invalidRecord(commandId, filePath);
  }
  return value as unknown as PromptDispatch;
}

function isActor(value: unknown): boolean {
  if (!isObject(value) || typeof value.type !== "string") return false;
  if (value.type === "human") return ["cli", "tui"].includes(String(value.source)) && Number.isInteger(value.processId);
  if (value.type === "agent") {
    return typeof value.taskId === "string" && typeof value.agentTabId === "string" && typeof value.capabilityId === "string";
  }
  return value.type === "system" && ["orchestration-supervisor", "heartbeat"].includes(String(value.component));
}

function isCommandError(value: unknown): value is PromptCommandError | null {
  return value === null || (isObject(value) && typeof value.code === "string" && typeof value.message === "string" &&
    typeof value.retryable === "boolean" && typeof value.deliveryUncertain === "boolean");
}

const commandPath = (paths: CraigPaths, commandId: string) => path.join(paths.commandsDir, `${commandId}.json`);
const assertCommandId = (commandId: string): void => {
  if (!/^command_[A-Za-z0-9_-]+$/.test(commandId)) {
    throw new CraigError("CLI_USAGE", `Invalid command id "${commandId}".`, { details: { commandId } });
  }
};
const isTimestamp = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && Number.isFinite(Date.parse(value));
const isSafePersistedPrompt = (value: string): boolean => value.trim().length > 0 && Buffer.byteLength(value) <= 32 * 1024 &&
  ![...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 8 || (code >= 11 && code <= 31) || (code >= 127 && code <= 159);
  });
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isMissing = (error: unknown): error is { code: "ENOENT" } =>
  typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
const invalidRecord = (commandId: string, filePath: string, cause?: unknown) => new CraigError(
  "COMMAND_RECORD_INVALID",
  `Craig command record at ${filePath} is invalid.`,
  { details: { commandId, filePath }, ...(cause ? { cause } : {}) },
);
