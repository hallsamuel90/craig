import { readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";

import type { WorkspaceRecord } from "../types/workspace.js";
import type { CraigPaths } from "./craig-paths.js";
import { atomicWriteJson } from "./atomic-write.js";

export async function readWorkspace(paths: CraigPaths, workspaceId: string): Promise<WorkspaceRecord> {
  const raw = await readFile(getWorkspaceFilePath(paths, workspaceId), "utf8");
  const parsed = JSON.parse(raw) as unknown;

  return validateWorkspaceRecord(parsed, getWorkspaceFilePath(paths, workspaceId));
}

export async function writeWorkspace(paths: CraigPaths, workspace: WorkspaceRecord): Promise<void> {
  await atomicWriteJson(getWorkspaceFilePath(paths, workspace.id), {
    ...workspace,
    updatedAt: new Date().toISOString(),
  });
}

export async function listWorkspaceRecords(paths: CraigPaths): Promise<WorkspaceRecord[]> {
  const entries = await readdir(paths.workspacesDir, { withFileTypes: true });
  const workspaces = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => readWorkspace(paths, path.basename(entry.name, ".json"))),
  );

  return workspaces.sort((left, right) => left.id.localeCompare(right.id));
}

export async function deleteWorkspace(paths: CraigPaths, workspaceId: string): Promise<void> {
  await rm(getWorkspaceFilePath(paths, workspaceId), { force: true });
}

function getWorkspaceFilePath(paths: CraigPaths, workspaceId: string): string {
  return path.join(paths.workspacesDir, `${workspaceId}.json`);
}

export function validateWorkspaceRecord(value: unknown, filePath: string): WorkspaceRecord {
  if (
    typeof value !== "object" ||
    value === null ||
    typeof (value as Partial<WorkspaceRecord>).id !== "string" ||
    typeof (value as Partial<WorkspaceRecord>).primaryRepoId !== "string" ||
    typeof (value as Partial<WorkspaceRecord>).branch !== "string" ||
    ((value as Partial<WorkspaceRecord>).status !== "active" &&
      (value as Partial<WorkspaceRecord>).status !== "archived") ||
    !Array.isArray((value as Partial<WorkspaceRecord>).linkedRepoIds) ||
    !((value as Partial<WorkspaceRecord>).linkedRepoIds ?? []).every((entry) => typeof entry === "string") ||
    !(
      (value as Partial<WorkspaceRecord>).archivedAt === null ||
      typeof (value as Partial<WorkspaceRecord>).archivedAt === "string"
    ) ||
    typeof (value as Partial<WorkspaceRecord>).createdAt !== "string" ||
    typeof (value as Partial<WorkspaceRecord>).updatedAt !== "string"
  ) {
    throw new Error(
      `Craig workspace record at ${filePath} is invalid. Remove or repair the file before rerunning Craig.`,
    );
  }

  return value as WorkspaceRecord;
}
