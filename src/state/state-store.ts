import { readFile } from "node:fs/promises";

import type { CraigIndex } from "../types/index.js";
import { atomicWriteJson } from "./atomic-write.js";
import type { CraigPaths } from "./craig-paths.js";

export async function readCraigIndex(paths: CraigPaths): Promise<CraigIndex> {
  const raw = await readFile(paths.indexFile, "utf8");
  const parsed = JSON.parse(raw) as unknown;

  return validateCraigIndex(parsed, paths.workspaceRoot, paths.indexFile);
}

export async function writeCraigIndex(paths: CraigPaths, index: CraigIndex): Promise<void> {
  const normalized: CraigIndex = {
    ...index,
    workspaceRoot: paths.workspaceRoot,
    updatedAt: new Date().toISOString(),
  };

  await atomicWriteJson(paths.indexFile, normalized);
}

export function validateCraigIndex(
  value: unknown,
  workspaceRoot: string,
  filePath: string,
): CraigIndex {
  if (!isCraigIndex(value)) {
    throw new Error(
      `Craig index at ${filePath} is invalid. Remove or repair the file before rerunning Craig.`,
    );
  }

  if (value.workspaceRoot !== workspaceRoot) {
    throw new Error(
      `Craig index at ${filePath} belongs to ${value.workspaceRoot}, not ${workspaceRoot}. Remove or repair the file before rerunning Craig.`,
    );
  }

  return value;
}

function isCraigIndex(value: unknown): value is CraigIndex {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Partial<CraigIndex>;

  return (
    candidate.version === 2 &&
    typeof candidate.workspaceRoot === "string" &&
    Array.isArray(candidate.repoIds) &&
    candidate.repoIds.every((entry) => typeof entry === "string") &&
    Array.isArray(candidate.workspaceIds) &&
    candidate.workspaceIds.every((entry) => typeof entry === "string") &&
    Array.isArray(candidate.taskIds) &&
    candidate.taskIds.every((entry) => typeof entry === "string") &&
    Array.isArray(candidate.jobIds) &&
    candidate.jobIds.every((entry) => typeof entry === "string") &&
    typeof candidate.createdAt === "string" &&
    typeof candidate.updatedAt === "string"
  );
}
