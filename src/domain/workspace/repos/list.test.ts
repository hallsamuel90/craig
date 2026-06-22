import { describe, expect, test } from "vitest";

import type { CraigPaths } from "../../../state/craig-paths.js";
import type { RepoRecord } from "../types.js";
import { listRegisteredRepos } from "./list.js";

const makePaths = (): CraigPaths => ({ workspaceRoot: "/workspace" } as unknown as CraigPaths);

const makeRepo = (id: string): RepoRecord => ({
  id,
  name: id,
  rootPath: `/workspace/${id}`,
  defaultBranch: "main",
  createdAt: "2024-01-01T00:00:00.000Z",
  updatedAt: "2024-01-01T00:00:00.000Z",
});

describe("listRegisteredRepos", () => {
  test("returns all repos", async () => {
    const repos = [makeRepo("repo_a"), makeRepo("repo_b")];
    const deps = { listRepos: async () => repos };
    const result = await listRegisteredRepos(makePaths(), deps);
    expect(result.kind).toBe("listRepos");
    expect(result.repos).toEqual(repos);
  });

  test("returns empty repos list when none exist", async () => {
    const deps = { listRepos: async () => [] };
    const result = await listRegisteredRepos(makePaths(), deps);
    expect(result.repos).toEqual([]);
  });
});
