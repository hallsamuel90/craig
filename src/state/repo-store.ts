import { readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";

import type { RepoRecord } from "../types/workspace.js";
import type { CraigPaths } from "./craig-paths.js";
import { atomicWriteJson } from "./atomic-write.js";

export async function readRepo(paths: CraigPaths, repoId: string): Promise<RepoRecord> {
  const raw = await readFile(getRepoFilePath(paths, repoId), "utf8");
  const parsed = JSON.parse(raw) as unknown;

  return validateRepoRecord(parsed, getRepoFilePath(paths, repoId));
}

export async function writeRepo(paths: CraigPaths, repo: RepoRecord): Promise<void> {
  await atomicWriteJson(getRepoFilePath(paths, repo.id), {
    ...repo,
    updatedAt: new Date().toISOString(),
  });
}

export async function listRepos(paths: CraigPaths): Promise<RepoRecord[]> {
  const entries = await readdir(paths.reposDir, { withFileTypes: true });
  const repos = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => readRepo(paths, path.basename(entry.name, ".json"))),
  );

  return repos.sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
}

export async function deleteRepo(paths: CraigPaths, repoId: string): Promise<void> {
  await rm(getRepoFilePath(paths, repoId), { force: true });
}

function getRepoFilePath(paths: CraigPaths, repoId: string): string {
  return path.join(paths.reposDir, `${repoId}.json`);
}

export function validateRepoRecord(value: unknown, filePath: string): RepoRecord {
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
}
