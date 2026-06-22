import { readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";

import type { CraigPaths } from "../../../state/craig-paths.js";
import { atomicWriteJson } from "../../../state/atomic-write.js";
import type { WorkspaceRecord } from "../types.js";

const getWorkspaceFilePath = (paths: CraigPaths, workspaceId: string): string =>
  path.join(paths.workspacesDir, `${workspaceId}.json`);

const normalizeWorkspaceRecord = (value: unknown): unknown => {
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
};

export const validateWorkspaceRecord = (value: unknown, filePath: string): WorkspaceRecord => {
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
};

export const readWorkspace = async (paths: CraigPaths, workspaceId: string): Promise<WorkspaceRecord> => {
  const filePath = getWorkspaceFilePath(paths, workspaceId);
  const raw = await readFile(filePath, "utf8");
  return validateWorkspaceRecord(JSON.parse(raw) as unknown, filePath);
};

export const writeWorkspace = async (paths: CraigPaths, workspace: WorkspaceRecord): Promise<void> => {
  await atomicWriteJson(getWorkspaceFilePath(paths, workspace.id), {
    ...workspace,
    updatedAt: new Date().toISOString(),
  });
};

export const listWorkspaceRecords = async (paths: CraigPaths): Promise<WorkspaceRecord[]> => {
  const entries = await readdir(paths.workspacesDir, { withFileTypes: true });
  const workspaces = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => readWorkspace(paths, path.basename(entry.name, ".json"))),
  );
  return workspaces.sort((left, right) => left.id.localeCompare(right.id));
};

export const deleteWorkspace = async (paths: CraigPaths, workspaceId: string): Promise<void> => {
  await rm(getWorkspaceFilePath(paths, workspaceId), { force: true });
};
