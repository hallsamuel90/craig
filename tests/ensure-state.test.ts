import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { getCraigPaths } from "../src/state/craig-paths.js";
import { ensureCraigState } from "../src/domain/workspace/workspaces/ensure.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map(async (root) => {
      await import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true, force: true }));
    }),
  );
});

describe("ensureCraigState", () => {
  test("creates the workspace-scoped Craig directory structure on first run", async () => {
    const workspaceRoot = await createWorkspaceRoot();
    const index = await ensureCraigState(workspaceRoot);
    const paths = getCraigPaths(workspaceRoot);

    await expect(readFile(paths.indexFile, "utf8")).resolves.toContain('"version": 2');
    await expect(import("node:fs/promises").then(({ stat }) => stat(paths.reposDir))).resolves.toBeTruthy();
    await expect(import("node:fs/promises").then(({ stat }) => stat(paths.workspacesDir))).resolves.toBeTruthy();
    await expect(import("node:fs/promises").then(({ stat }) => stat(paths.runtimeDir))).resolves.toBeTruthy();
    expect(index.workspaceRoot).toBe(workspaceRoot);
    expect(index.repoIds).toEqual([]);
    expect(index.workspaceIds).toEqual([]);
    expect(index.taskIds).toEqual([]);
    expect(index.jobIds).toEqual([]);
  });

  test("preserves an existing valid workspace index", async () => {
    const workspaceRoot = await createWorkspaceRoot();
    const paths = getCraigPaths(workspaceRoot);

    await mkdir(paths.craigDir, { recursive: true });
    await Promise.all([
      mkdir(paths.reposDir, { recursive: true }),
      mkdir(paths.workspacesDir, { recursive: true }),
      mkdir(paths.runtimeDir, { recursive: true }),
      mkdir(paths.tasksDir, { recursive: true }),
      mkdir(paths.jobsDir, { recursive: true }),
      mkdir(paths.logsDir, { recursive: true }),
      mkdir(paths.artifactsDir, { recursive: true }),
      mkdir(paths.worktreesDir, { recursive: true }),
    ]);

    const preserved = {
      version: 2,
      workspaceRoot,
      repoIds: ["repo_one"],
      workspaceIds: ["workspace_repo_one"],
      taskIds: [],
      jobIds: [],
      createdAt: "2026-04-21T00:00:00.000Z",
      updatedAt: "2026-04-21T00:00:00.000Z",
    };

    await writeFile(paths.indexFile, `${JSON.stringify(preserved, null, 2)}\n`, "utf8");

    const index = await ensureCraigState(workspaceRoot);

    expect(index).toEqual(preserved);
  });

  test("fails on malformed existing index", async () => {
    const workspaceRoot = await createWorkspaceRoot();
    const paths = getCraigPaths(workspaceRoot);

    await mkdir(paths.craigDir, { recursive: true });
    await writeFile(paths.indexFile, "{bad json", "utf8");

    await expect(ensureCraigState(workspaceRoot)).rejects.toThrow(/malformed/);
  });

  test("ignores legacy repo-local Craig state outside the current workspace root", async () => {
    const parentRoot = await createWorkspaceRoot();
    const legacyRepoRoot = path.join(parentRoot, "legacy-repo");
    const freshWorkspaceRoot = path.join(parentRoot, "fresh-workspace");

    await mkdir(path.join(legacyRepoRoot, ".craig"), { recursive: true });
    await writeFile(
      path.join(legacyRepoRoot, ".craig", "index.json"),
      JSON.stringify({ version: 1, repoRoot: legacyRepoRoot, taskIds: [], jobIds: [] }, null, 2),
      "utf8",
    );
    await mkdir(freshWorkspaceRoot, { recursive: true });

    const index = await ensureCraigState(freshWorkspaceRoot);
    const paths = getCraigPaths(freshWorkspaceRoot);

    expect(index.workspaceRoot).toBe(freshWorkspaceRoot);
    await expect(readFile(paths.indexFile, "utf8")).resolves.toContain('"workspaceRoot"');
  });
});

async function createWorkspaceRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "craig-state-"));
  tempRoots.push(root);
  return root;
}
