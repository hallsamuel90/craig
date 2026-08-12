import { mkdir, readFile } from "node:fs/promises";

import { getCraigPaths } from "../../../state/craig-paths.js";
import { atomicWriteJson } from "../../../shared/atomic-write.js";
import { validateCraigIndex } from "../adapters/index-store.js";
import type { CraigIndex } from "../types.js";

const isFileMissingError = (error: unknown): error is { code: string } =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  typeof (error as { code?: unknown }).code === "string" &&
  (error as { code: string }).code === "ENOENT";

export const ensureCraigState = async (workspaceRoot: string): Promise<CraigIndex> => {
  const paths = getCraigPaths(workspaceRoot);

  await mkdir(paths.craigDir, { recursive: true });
  await Promise.all([
    mkdir(paths.reposDir, { recursive: true }),
    mkdir(paths.workspacesDir, { recursive: true }),
    mkdir(paths.runtimeDir, { recursive: true }),
    mkdir(paths.tasksDir, { recursive: true }),
    mkdir(paths.jobsDir, { recursive: true }),
    mkdir(paths.commandsDir, { recursive: true }),
    mkdir(paths.eventsDir, { recursive: true }),
    mkdir(paths.orchestrationDir, { recursive: true }),
    mkdir(paths.logsDir, { recursive: true }),
    mkdir(paths.artifactsDir, { recursive: true }),
    mkdir(paths.worktreesDir, { recursive: true }),
  ]);

  try {
    const existing = await readFile(paths.indexFile, "utf8");
    const parsed = JSON.parse(existing) as unknown;
    return validateCraigIndex(parsed, workspaceRoot, paths.indexFile);
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
    version: 2,
    workspaceRoot,
    repoIds: [],
    workspaceIds: [],
    taskIds: [],
    jobIds: [],
    createdAt: timestamp,
    updatedAt: timestamp,
  };

  await atomicWriteJson(paths.indexFile, index);
  return index;
};
