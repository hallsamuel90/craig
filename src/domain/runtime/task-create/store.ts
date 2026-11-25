import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import type { CraigPaths } from "../../../state/craig-paths.js";
import { atomicWriteJson } from "../../../shared/atomic-write.js";
import type { CommandCreateTaskResult } from "../../task/index.js";
import type { CommandCreateChildResult } from "../../orchestration/index.js";

export interface TaskCreateOperation {
  schemaVersion: 1;
  operationId: string;
  requestDigest: string;
  taskId: string;
  agentTabId: string;
  sessionId: string;
  creationId: string;
  hostId: string;
  creationViewToken?: string;
  state: "admitted" | "provisioning" | "provisioned" | "launching" | "completed" | "failed" | "recovery_required";
  createdAt: string;
  updatedAt: string;
  result?: CommandCreateTaskResult | CommandCreateChildResult;
  error?: string;
}
export function taskCreateRequestDigest(request: unknown): string {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
    return value;
  };
  return createHash("sha256").update(JSON.stringify(canonical(request))).digest("hex");
}
function directory(paths: CraigPaths): string { return path.join(paths.craigDir, "operations", "task-create"); }
function file(paths: CraigPaths, id: string): string {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id)) throw new Error("Invalid task-create operation id.");
  return path.join(directory(paths), `${id}.json`);
}
export async function readTaskCreateOperation(paths: CraigPaths, operationId: string): Promise<TaskCreateOperation | null> {
  const target = file(paths, operationId);
  const metadata = await lstat(target).catch((error: unknown) => { if ((error as { code?: string }).code === "ENOENT") return null; throw error; });
  if (!metadata) return null;
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.uid !== process.getuid?.() || (metadata.mode & 0o077) !== 0) throw new Error("Unsafe task-create recovery record.");
  const record = JSON.parse(await readFile(target, "utf8")) as TaskCreateOperation;
  if (record.schemaVersion !== 1 || record.operationId !== operationId || typeof record.taskId !== "string" || typeof record.requestDigest !== "string" || !["admitted", "provisioning", "provisioned", "launching", "completed", "failed", "recovery_required"].includes(record.state)) throw new Error("Invalid task-create recovery record.");
  return record;
}
export async function writeTaskCreateOperation(paths: CraigPaths, operation: TaskCreateOperation): Promise<void> {
  await mkdir(directory(paths), { recursive: true, mode: 0o700 });
  await atomicWriteJson(file(paths, operation.operationId), { ...operation, updatedAt: new Date().toISOString() }, { mode: 0o600 });
}
export async function listTaskCreateOperations(paths: CraigPaths): Promise<TaskCreateOperation[]> {
  const names = await readdir(directory(paths)).catch((error: unknown) => { if ((error as { code?: string }).code === "ENOENT") return []; throw error; });
  return Promise.all(names.filter((name) => name.endsWith(".json")).map(async (name) => {
    const operation = await readTaskCreateOperation(paths, name.slice(0, -5)); if (!operation) throw new Error("Task-create inventory changed."); return operation;
  }));
}
