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
  const normalized = normalizeWorkspaceRecord(value);
  if (
    typeof normalized !== "object" ||
    normalized === null ||
    typeof (normalized as Partial<WorkspaceRecord>).id !== "string" ||
    ((normalized as Partial<WorkspaceRecord>).kind !== "repo" &&
      (normalized as Partial<WorkspaceRecord>).kind !== "project") ||
    typeof (normalized as Partial<WorkspaceRecord>).name !== "string" ||
    typeof (normalized as Partial<WorkspaceRecord>).rootPath !== "string" ||
    typeof (normalized as Partial<WorkspaceRecord>).primaryRepoId !== "string" ||
    typeof (normalized as Partial<WorkspaceRecord>).branch !== "string" ||
    ((normalized as Partial<WorkspaceRecord>).status !== "active" &&
      (normalized as Partial<WorkspaceRecord>).status !== "archived") ||
    !Array.isArray((normalized as Partial<WorkspaceRecord>).linkedRepoIds) ||
    !((normalized as Partial<WorkspaceRecord>).linkedRepoIds ?? []).every((entry) => typeof entry === "string") ||
    !(
      (normalized as Partial<WorkspaceRecord>).repoId === undefined ||
      typeof (normalized as Partial<WorkspaceRecord>).repoId === "string"
    ) ||
    !Array.isArray((normalized as Partial<WorkspaceRecord>).discoveredRepoIds) ||
    !((normalized as Partial<WorkspaceRecord>).discoveredRepoIds ?? []).every((entry) => typeof entry === "string") ||
    !(
      (normalized as Partial<WorkspaceRecord>).archivedAt === null ||
      typeof (normalized as Partial<WorkspaceRecord>).archivedAt === "string"
    ) ||
    typeof (normalized as Partial<WorkspaceRecord>).createdAt !== "string" ||
    typeof (normalized as Partial<WorkspaceRecord>).updatedAt !== "string"
  ) {
    throw new Error(
      `Craig workspace record at ${filePath} is invalid. Remove or repair the file before rerunning Craig.`,
    );
  }

  return normalized as WorkspaceRecord;
}

function normalizeWorkspaceRecord(value: unknown): unknown {
  if (typeof value !== "object" || value === null) {
    return value;
  }

  const candidate = value as Partial<WorkspaceRecord>;
  const repoId = candidate.repoId ?? candidate.primaryRepoId;

  return {
    ...candidate,
    kind: candidate.kind ?? "repo",
    name: candidate.name ?? repoId ?? candidate.id,
    rootPath: candidate.rootPath ?? "",
    primaryRepoId: candidate.primaryRepoId ?? repoId ?? "",
    repoId: candidate.kind === "project" ? candidate.repoId : repoId,
    discoveredRepoIds: Array.isArray(candidate.discoveredRepoIds)
      ? candidate.discoveredRepoIds.filter((entry): entry is string => typeof entry === "string")
      : candidate.kind === "project"
        ? []
        : repoId
          ? [repoId]
          : [],
    linkedRepoIds: Array.isArray(candidate.linkedRepoIds)
      ? candidate.linkedRepoIds.filter((entry): entry is string => typeof entry === "string")
      : [],
  };
}
