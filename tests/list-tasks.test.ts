import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { listTasks } from "../src/services/list-tasks.js";
import { getCraigPaths } from "../src/state/craig-paths.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map(async (root) => {
      await import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true, force: true }));
    }),
  );
});

describe("listTasks", () => {
  test("returns an empty task list for an empty index", async () => {
    const repoRoot = await createRepoRoot();
    const paths = await createCraigState(repoRoot, []);

    const result = await listTasks(paths);

    expect(result.tasks).toEqual([]);
    expect(result.missingTaskIds).toEqual([]);
  });

  test("reports missing task files without failing the list", async () => {
    const repoRoot = await createRepoRoot();
    const paths = await createCraigState(repoRoot, ["task_1"]);

    const result = await listTasks(paths);

    expect(result.tasks).toEqual([]);
    expect(result.missingTaskIds).toEqual(["task_1"]);
  });
});

async function createRepoRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "craig-list-"));
  tempRoots.push(root);
  return root;
}

async function createCraigState(repoRoot: string, taskIds: string[]) {
  const paths = getCraigPaths(repoRoot);

  await mkdir(paths.craigDir, { recursive: true });
  await Promise.all([
    mkdir(paths.tasksDir, { recursive: true }),
    mkdir(paths.jobsDir, { recursive: true }),
    mkdir(paths.logsDir, { recursive: true }),
    mkdir(paths.artifactsDir, { recursive: true }),
    mkdir(paths.worktreesDir, { recursive: true }),
  ]);
  await writeFile(
    paths.indexFile,
    JSON.stringify(
      {
        version: 1,
        repoRoot,
        taskIds,
        jobIds: [],
        createdAt: "2026-04-21T00:00:00.000Z",
        updatedAt: "2026-04-21T00:00:00.000Z",
      },
      null,
      2,
    ),
  );

  return paths;
}
