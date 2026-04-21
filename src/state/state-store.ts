import { readFile } from "node:fs/promises";

import type { CraigIndex } from "../types/index.js";
import { atomicWriteJson } from "./atomic-write.js";
import type { CraigPaths } from "./craig-paths.js";

export async function readCraigIndex(paths: CraigPaths): Promise<CraigIndex> {
  const raw = await readFile(paths.indexFile, "utf8");
  const parsed = JSON.parse(raw) as unknown;

  return validateCraigIndex(parsed, paths.repoRoot, paths.indexFile);
}

export async function writeCraigIndex(paths: CraigPaths, index: CraigIndex): Promise<void> {
  const normalized: CraigIndex = {
    ...index,
    repoRoot: paths.repoRoot,
    updatedAt: new Date().toISOString(),
  };

  await atomicWriteJson(paths.indexFile, normalized);
}

export function validateCraigIndex(
  value: unknown,
  repoRoot: string,
  filePath: string,
): CraigIndex {
  if (!isCraigIndex(value)) {
    throw new Error(
      `Craig index at ${filePath} is invalid. Remove or repair the file before rerunning Craig.`,
    );
  }

  if (value.repoRoot !== repoRoot) {
    throw new Error(
      `Craig index at ${filePath} belongs to ${value.repoRoot}, not ${repoRoot}. Remove or repair the file before rerunning Craig.`,
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
    candidate.version === 1 &&
    typeof candidate.repoRoot === "string" &&
    Array.isArray(candidate.taskIds) &&
    candidate.taskIds.every((entry) => typeof entry === "string") &&
    Array.isArray(candidate.jobIds) &&
    candidate.jobIds.every((entry) => typeof entry === "string") &&
    typeof candidate.createdAt === "string" &&
    typeof candidate.updatedAt === "string"
  );
}
