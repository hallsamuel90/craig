import { describe, expect, test } from "vitest";

import type { CraigPaths } from "../../../state/craig-paths.js";
import type { WorkspaceRecord } from "../types.js";
import { listWorkspaces } from "./list.js";

const makePaths = (): CraigPaths => ({ workspaceRoot: "/workspace" } as unknown as CraigPaths);

const makeWorkspace = (id: string, status: "active" | "archived"): WorkspaceRecord => ({
  id,
  kind: "repo",
  name: id,
  rootPath: `/workspace/${id}`,
  primaryRepoId: `repo_${id}`,
  branch: "main",
  status,
  linkedRepoIds: [],
  archivedAt: status === "archived" ? "2024-01-01T00:00:00.000Z" : null,
  createdAt: "2024-01-01T00:00:00.000Z",
  updatedAt: "2024-01-01T00:00:00.000Z",
});

describe("listWorkspaces", () => {
  test("returns only active workspaces when archived=false", async () => {
    const records = [makeWorkspace("a", "active"), makeWorkspace("b", "archived")];
    const deps = { listWorkspaceRecords: async () => records };
    const result = await listWorkspaces(makePaths(), { archived: false }, deps);
    expect(result.workspaces.map((w) => w.id)).toEqual(["a"]);
    expect(result.archivedOnly).toBe(false);
  });

  test("returns only archived workspaces when archived=true", async () => {
    const records = [makeWorkspace("a", "active"), makeWorkspace("b", "archived")];
    const deps = { listWorkspaceRecords: async () => records };
    const result = await listWorkspaces(makePaths(), { archived: true }, deps);
    expect(result.workspaces.map((w) => w.id)).toEqual(["b"]);
    expect(result.archivedOnly).toBe(true);
  });

  test("returns empty when no workspaces exist", async () => {
    const deps = { listWorkspaceRecords: async () => [] };
    const result = await listWorkspaces(makePaths(), { archived: false }, deps);
    expect(result.workspaces).toEqual([]);
  });
});
