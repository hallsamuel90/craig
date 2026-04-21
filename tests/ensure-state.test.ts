import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { getCraigPaths } from "../src/state/craig-paths.js";
import { ensureCraigState } from "../src/state/ensure-state.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map(async (root) => {
      await import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true, force: true }));
    }),
  );
});

describe("ensureCraigState", () => {
  test("creates the Craig directory structure and index on first run", async () => {
    const repoRoot = await createRepoRoot();
    const index = await ensureCraigState(repoRoot);
    const paths = getCraigPaths(repoRoot);

    await expect(readFile(paths.indexFile, "utf8")).resolves.toContain('"version": 1');
    await expect(import("node:fs/promises").then(({ stat }) => stat(paths.tasksDir))).resolves.toBeTruthy();
    expect(index.repoRoot).toBe(repoRoot);
    expect(index.taskIds).toEqual([]);
    expect(index.jobIds).toEqual([]);
  });

  test("preserves an existing valid index", async () => {
    const repoRoot = await createRepoRoot();
    const paths = getCraigPaths(repoRoot);

    await mkdir(paths.craigDir, { recursive: true });
    await Promise.all([
      mkdir(paths.tasksDir, { recursive: true }),
      mkdir(paths.jobsDir, { recursive: true }),
      mkdir(paths.logsDir, { recursive: true }),
      mkdir(paths.artifactsDir, { recursive: true }),
      mkdir(paths.worktreesDir, { recursive: true }),
    ]);

    const preserved = {
      version: 1,
      repoRoot,
      taskIds: ["task_1"],
      jobIds: [],
      createdAt: "2026-04-21T00:00:00.000Z",
      updatedAt: "2026-04-21T00:00:00.000Z",
    };

    await writeFile(paths.indexFile, `${JSON.stringify(preserved, null, 2)}\n`, "utf8");

    const index = await ensureCraigState(repoRoot);

    expect(index).toEqual(preserved);
  });

  test("fails on malformed existing index", async () => {
    const repoRoot = await createRepoRoot();
    const paths = getCraigPaths(repoRoot);

    await mkdir(paths.craigDir, { recursive: true });
    await writeFile(paths.indexFile, "{bad json", "utf8");

    await expect(ensureCraigState(repoRoot)).rejects.toThrow(/malformed/);
  });
});

async function createRepoRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "craig-state-"));
  tempRoots.push(root);
  return root;
}
