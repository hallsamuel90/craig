import { readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";

import type { CraigPaths } from "../../../state/craig-paths.js";
import { CraigError } from "../../error/index.js";
import { atomicWriteJson } from "../../../shared/atomic-write.js";
import type { RepoRecord } from "../types.js";

const getRepoFilePath = (paths: CraigPaths, repoId: string): string =>
  path.join(paths.reposDir, `${repoId}.json`);

export const validateRepoRecord = (value: unknown, filePath: string): RepoRecord => {
  if (
    typeof value !== "object" ||
    value === null ||
    typeof (value as Partial<RepoRecord>).id !== "string" ||
    typeof (value as Partial<RepoRecord>).name !== "string" ||
    typeof (value as Partial<RepoRecord>).rootPath !== "string" ||
    typeof (value as Partial<RepoRecord>).defaultBranch !== "string" ||
    typeof (value as Partial<RepoRecord>).createdAt !== "string" ||
    typeof (value as Partial<RepoRecord>).updatedAt !== "string"
  ) {
    throw new Error(`Craig repo record at ${filePath} is invalid. Remove or repair the file before rerunning Craig.`);
  }
  return value as RepoRecord;
};

export const readRepo = async (paths: CraigPaths, repoId: string): Promise<RepoRecord> => {
  const filePath = getRepoFilePath(paths, repoId);
  try {
    const raw = await readFile(filePath, "utf8");
    return validateRepoRecord(JSON.parse(raw) as unknown, filePath);
  } catch (error) {
    if (isFileMissingError(error)) {
      throw new CraigError("REPO_NOT_FOUND", `Craig repo "${repoId}" was not found.`, {
        details: { repoId },
      });
    }
    if (
      error instanceof SyntaxError ||
      (error instanceof Error && error.message.startsWith("Craig repo record at "))
    ) {
      throw new CraigError(
        "REPO_RECORD_INVALID",
        error instanceof Error ? error.message : `Craig repo "${repoId}" is invalid.`,
        { details: { repoId }, cause: error },
      );
    }
    throw error;
  }
};

export const writeRepo = async (paths: CraigPaths, repo: RepoRecord): Promise<void> => {
  await atomicWriteJson(getRepoFilePath(paths, repo.id), {
    ...repo,
    updatedAt: new Date().toISOString(),
  });
};

export const listRepos = async (paths: CraigPaths): Promise<RepoRecord[]> => {
  const entries = await readdir(paths.reposDir, { withFileTypes: true });
  const repos = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => readRepo(paths, path.basename(entry.name, ".json"))),
  );
  return repos.sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
};

export const deleteRepo = async (paths: CraigPaths, repoId: string): Promise<void> => {
  await rm(getRepoFilePath(paths, repoId), { force: true });
};

const isFileMissingError = (error: unknown): error is { code: string } =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  (error as { code?: unknown }).code === "ENOENT";
