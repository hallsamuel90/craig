import { randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, readdir } from "node:fs/promises";
import path from "node:path";

import type { CraigPaths } from "../../../state/craig-paths.js";
import { atomicWriteJson } from "../../../shared/atomic-write.js";
import { CraigError } from "../../error/index.js";
import { mutateTask, taskService, type TaskRecord } from "../../task/index.js";
import type { CraigActor } from "../types.js";
import type { AgentCapabilityRecord, DelegationCommandFamily } from "./types.js";

const CAPABILITY_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
const DEFAULT_LIMITS = {
  maxChildren: 8,
  maxDepth: 4,
  maxConcurrentChildren: 4,
  maxPromptBytes: 32 * 1024,
} as const;

export async function ensureTaskCapabilities(
  paths: CraigPaths,
  task: TaskRecord,
  issuedBy: CraigActor = { type: "system", component: "orchestration-supervisor" },
): Promise<Record<string, string>> {
  const requestedTab = task.ptyTabs.find((candidate) => candidate.kind === "agent");
  if (!requestedTab) return {};
  let persistedToken: string | null = null;
  await mkdir(capabilitiesDir(paths), { recursive: true, mode: 0o700 });
  await mutateTask(paths, task.id, async (current) => {
    const tab = current.ptyTabs.find((candidate) => candidate.id === requestedTab.id && candidate.kind === "agent");
    if (!tab) throw new CraigError("CAPABILITY_DENIED", `Agent tab ${requestedTab.id} no longer exists.`, {});
    const capabilityId = tab.capabilityId ?? `capability_${randomUUID()}`;
    const existing = await readCapabilityIfExists(paths, capabilityId);
    if (existing && (existing.taskId !== current.id || existing.agentTabId !== tab.id)) {
      throw new CraigError("CAPABILITY_DENIED", `Capability ${capabilityId} is bound to another agent.`, {
        details: { capabilityId, taskId: current.id, agentTabId: tab.id },
      });
    }
    const persisted = existing ?? await createCapability(paths, capabilityId, current.id, tab.id, issuedBy);
    persistedToken = persisted.token;
    if (tab.capabilityId) return current;
    return {
      ...current,
      ptyTabs: current.ptyTabs.map((candidate) => candidate.id === tab.id
        ? { ...candidate, capabilityId }
        : candidate),
    };
  });
  if (!persistedToken) throw new CraigError("INTERNAL_ERROR", `Failed to issue a capability for ${requestedTab.id}.`, {});
  return { CRAIG_AGENT_CAPABILITY: persistedToken };
}

async function createCapability(
  paths: CraigPaths,
  capabilityId: string,
  taskId: string,
  agentTabId: string,
  issuedBy: CraigActor,
): Promise<AgentCapabilityRecord> {
  const now = new Date();
  const record: AgentCapabilityRecord = {
    schemaVersion: 1,
    id: capabilityId,
    token: `${capabilityId}.${randomUUID()}`,
    taskId,
    agentTabId,
    allowedCommandFamilies: ["task.create-child", "task.children", "task.cancel-tree"],
    targetPolicy: "children-only",
    limits: { ...DEFAULT_LIMITS },
    issuedBy,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + CAPABILITY_TTL_MS).toISOString(),
    revokedAt: null,
    revokedBy: null,
  };
  await atomicWriteJson(capabilityPath(paths, record.id), record, { mode: 0o600 });
  return record;
}

export async function authorizeCapability(
  paths: CraigPaths,
  capabilityToken: string,
  commandFamily: DelegationCommandFamily,
  targetTaskId: string,
): Promise<{ actor: Extract<CraigActor, { type: "agent" }>; capability: AgentCapabilityRecord }> {
  const capability = await readCapability(paths, capabilityToken);
  if (capability.revokedAt) denied(capability.id, "revoked");
  if (Date.parse(capability.expiresAt) <= Date.now()) denied(capability.id, "expired");
  if (!capability.allowedCommandFamilies.includes(commandFamily)) denied(capability.id, "command family is not allowed");
  if (capability.targetPolicy === "children-only" && !await isTaskInSubtree(paths, capability.taskId, targetTaskId)) {
    denied(capability.id, `target task ${targetTaskId} is outside the capability task subtree`);
  }
  return {
    capability,
    actor: { type: "agent", taskId: capability.taskId, agentTabId: capability.agentTabId, capabilityId: capability.id },
  };
}

async function isTaskInSubtree(paths: CraigPaths, ownerTaskId: string, targetTaskId: string): Promise<boolean> {
  if (ownerTaskId === targetTaskId) return true;
  const tasks = (await taskService.listTasks(paths, { includeClosed: true })).tasks;
  const byId = new Map(tasks.map((task) => [task.id, task]));
  let current = byId.get(targetTaskId);
  const visited = new Set<string>();
  while (current?.parentTaskId && !visited.has(current.id)) {
    if (current.parentTaskId === ownerTaskId) return true;
    visited.add(current.id);
    current = byId.get(current.parentTaskId);
  }
  return false;
}

export async function revokeCapability(paths: CraigPaths, capabilityId: string, actor: CraigActor): Promise<void> {
  const record = await readCapabilityIfExists(paths, capabilityId);
  if (!record) return;
  if (record.revokedAt) return;
  await atomicWriteJson(capabilityPath(paths, capabilityId), {
    ...record,
    revokedAt: new Date().toISOString(),
    revokedBy: actor,
  }, { mode: 0o600 });
}

export async function revokeTaskCapabilities(paths: CraigPaths, taskIds: Set<string>, actor: CraigActor): Promise<string[]> {
  const names = await readdir(capabilitiesDir(paths)).catch((error: unknown) => isMissing(error) ? [] : Promise.reject(error));
  const revoked: string[] = [];
  for (const name of names) {
    const match = /^(capability_[A-Za-z0-9-]+)\.json$/.exec(name);
    if (!match) continue;
    const record = await readCapabilityIfExists(paths, match[1]!);
    if (!record || !taskIds.has(record.taskId)) continue;
    await revokeCapability(paths, record.id, actor);
    revoked.push(record.id);
  }
  return revoked;
}

async function readCapability(paths: CraigPaths, capabilityToken: string): Promise<AgentCapabilityRecord> {
  const separator = capabilityToken.indexOf(".");
  const capabilityId = separator > 0 ? capabilityToken.slice(0, separator) : "";
  if (!/^capability_[A-Za-z0-9-]+$/.test(capabilityId)) denied("<redacted>", "token is invalid");
  const record = await readCapabilityIfExists(paths, capabilityId);
  if (!record) {
    throw new CraigError("CAPABILITY_NOT_FOUND", `Craig capability "${capabilityId}" was not found.`, {
      details: { capabilityId },
    });
  }
  const expected = Buffer.from(record.token);
  const supplied = Buffer.from(capabilityToken);
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) denied(capabilityId, "token is invalid");
  return record;
}

async function readCapabilityIfExists(paths: CraigPaths, capabilityId: string): Promise<AgentCapabilityRecord | null> {
  if (!/^capability_[A-Za-z0-9-]+$/.test(capabilityId)) denied(capabilityId, "identifier is invalid");
  try {
    const value = JSON.parse(await readFile(capabilityPath(paths, capabilityId), "utf8")) as unknown;
    if (!isCapability(value, capabilityId)) {
      throw new CraigError("CAPABILITY_RECORD_INVALID", `Craig capability record for ${capabilityId} is invalid.`, {
        details: { capabilityId },
      });
    }
    return value;
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

function isCapability(value: unknown, id: string): value is AgentCapabilityRecord {
  if (!isObject(value) || value.schemaVersion !== 1 || value.id !== id) return false;
  const limits = value.limits;
  return typeof value.token === "string" && value.token.startsWith(`${id}.`) && value.token.length > id.length + 1 &&
    typeof value.taskId === "string" && typeof value.agentTabId === "string" &&
    Array.isArray(value.allowedCommandFamilies) && value.allowedCommandFamilies.every((entry) =>
      ["task.create-child", "task.children", "task.cancel-tree"].includes(String(entry))) &&
    value.targetPolicy === "children-only" && isObject(limits) &&
    [limits.maxChildren, limits.maxDepth, limits.maxConcurrentChildren, limits.maxPromptBytes]
      .every((entry) => Number.isInteger(entry) && Number(entry) > 0) &&
    isTimestamp(value.createdAt) && isTimestamp(value.expiresAt) &&
    isActor(value.issuedBy) &&
    ((value.revokedAt === null && value.revokedBy === null) || (isTimestamp(value.revokedAt) && isActor(value.revokedBy)));
}

function isActor(value: unknown): boolean {
  if (!isObject(value)) return false;
  if (value.type === "human") return ["cli", "tui"].includes(String(value.source)) && Number.isInteger(value.processId);
  if (value.type === "agent") {
    return typeof value.taskId === "string" && typeof value.agentTabId === "string" && typeof value.capabilityId === "string";
  }
  return value.type === "system" && ["orchestration-supervisor", "heartbeat"].includes(String(value.component));
}

function denied(capabilityId: string, reason: string): never {
  throw new CraigError("CAPABILITY_DENIED", `Craig capability ${capabilityId} was denied: ${reason}.`, {
    details: { capabilityId, reason },
  });
}

const capabilitiesDir = (paths: CraigPaths) => path.join(paths.orchestrationDir, "capabilities");
const capabilityPath = (paths: CraigPaths, id: string) => path.join(capabilitiesDir(paths), `${id}.json`);
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isTimestamp = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value));
const isMissing = (error: unknown): error is { code: "ENOENT" } => typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
