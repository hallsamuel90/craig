import { readFile } from "node:fs/promises";

import type { CraigPaths } from "../../../state/craig-paths.js";
import { atomicWriteJson } from "../../../state/atomic-write.js";
import type { CraigIndex } from "../types.js";

const isCraigIndex = (value: unknown): value is CraigIndex => {
  if (typeof value !== "object" || value === null) return false;
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
};

export const validateCraigIndex = (value: unknown, workspaceRoot: string, filePath: string): CraigIndex => {
  if (!isCraigIndex(value)) {
    throw new Error(`Craig index at ${filePath} is invalid. Remove or repair the file before rerunning Craig.`);
  }
  if (value.workspaceRoot !== workspaceRoot) {
    throw new Error(
      `Craig index at ${filePath} belongs to ${value.workspaceRoot}, not ${workspaceRoot}. Remove or repair the file before rerunning Craig.`,
    );
  }
  return value;
};

export const readCraigIndex = async (paths: CraigPaths): Promise<CraigIndex> => {
  const raw = await readFile(paths.indexFile, "utf8");
  return validateCraigIndex(JSON.parse(raw) as unknown, paths.workspaceRoot, paths.indexFile);
};

export const writeCraigIndex = async (paths: CraigPaths, index: CraigIndex): Promise<void> => {
  await atomicWriteJson(paths.indexFile, {
    ...index,
    workspaceRoot: paths.workspaceRoot,
    updatedAt: new Date().toISOString(),
  });
};
