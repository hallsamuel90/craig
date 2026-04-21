import { mkdir, readFile } from "node:fs/promises";

import type { CraigIndex } from "../types/index.js";
import { atomicWriteJson } from "./atomic-write.js";
import { getCraigPaths } from "./craig-paths.js";
import { validateCraigIndex } from "./state-store.js";

export async function ensureCraigState(repoRoot: string): Promise<CraigIndex> {
  const paths = getCraigPaths(repoRoot);

  await mkdir(paths.craigDir, { recursive: true });
  await Promise.all([
    mkdir(paths.tasksDir, { recursive: true }),
    mkdir(paths.jobsDir, { recursive: true }),
    mkdir(paths.logsDir, { recursive: true }),
    mkdir(paths.artifactsDir, { recursive: true }),
    mkdir(paths.worktreesDir, { recursive: true }),
  ]);

  try {
    const existing = await readFile(paths.indexFile, "utf8");
    const parsed = JSON.parse(existing) as unknown;

    return validateCraigIndex(parsed, repoRoot, paths.indexFile);
  } catch (error) {
    if (!isFileMissingError(error)) {
      if (error instanceof SyntaxError) {
        throw new Error(
          `Craig index at ${paths.indexFile} is malformed. Remove or repair the file before rerunning Craig.`,
        );
      }

      throw error;
    }
  }

  const timestamp = new Date().toISOString();
  const index: CraigIndex = {
    version: 1,
    repoRoot,
    taskIds: [],
    jobIds: [],
    createdAt: timestamp,
    updatedAt: timestamp,
  };

  await atomicWriteJson(paths.indexFile, index);

  return index;
}

function isFileMissingError(error: unknown): error is { code: string } {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    error.code === "ENOENT"
  );
}
