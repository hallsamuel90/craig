import { describe, expect, test } from "vitest";

import type { CraigPaths } from "../../../state/craig-paths.js";
import type { CraigIndex } from "../types.js";
import { removeWorkspaceRecord } from "./remove-record.js";

const makePaths = (): CraigPaths => ({ workspaceRoot: "/workspace" } as unknown as CraigPaths);

const makeIndex = (workspaceIds: string[]): CraigIndex => ({
  version: 2,
  workspaceRoot: "/workspace",
  repoIds: [],
  workspaceIds,
  taskIds: [],
  jobIds: [],
  createdAt: "2024-01-01T00:00:00.000Z",
  updatedAt: "2024-01-01T00:00:00.000Z",
});

describe("removeWorkspaceRecord", () => {
  test("removes workspaceId from index and deletes workspace file", async () => {
    let deleted: string | undefined;
    let writtenIndex: CraigIndex | undefined;
    const deps = {
      deleteWorkspace: async (_p: CraigPaths, id: string) => { deleted = id; },
      readCraigIndex: async () => makeIndex(["workspace_foo", "workspace_bar"]),
      writeCraigIndex: async (_p: CraigPaths, idx: CraigIndex) => { writtenIndex = idx; },
    };
    await removeWorkspaceRecord(makePaths(), "workspace_foo", deps);
    expect(deleted).toBe("workspace_foo");
    expect(writtenIndex?.workspaceIds).toEqual(["workspace_bar"]);
  });

  test("is idempotent when workspaceId is not in index", async () => {
    let writtenIndex: CraigIndex | undefined;
    const deps = {
      deleteWorkspace: async () => undefined,
      readCraigIndex: async () => makeIndex(["workspace_bar"]),
      writeCraigIndex: async (_p: CraigPaths, idx: CraigIndex) => { writtenIndex = idx; },
    };
    await removeWorkspaceRecord(makePaths(), "workspace_missing", deps);
    expect(writtenIndex?.workspaceIds).toEqual(["workspace_bar"]);
  });
});
