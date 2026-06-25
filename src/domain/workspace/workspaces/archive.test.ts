import { describe, expect, test } from "vitest";

import type { CraigPaths } from "../../../state/craig-paths.js";
import type { WorkspaceRecord } from "../types.js";
import { archiveWorkspace } from "./archive.js";

const makePaths = (): CraigPaths => ({
  workspaceRoot: "/workspace",
  uiStateFile: "/workspace/.craig/ui-state.json",
} as unknown as CraigPaths);

const makeWorkspace = (status: "active" | "archived"): WorkspaceRecord => ({
  id: "workspace_repo_foo",
  kind: "repo",
  name: "foo",
  rootPath: "/foo",
  primaryRepoId: "repo_foo",
  branch: "main",
  status,
  linkedRepoIds: [],
  archivedAt: null,
  createdAt: "2024-01-01T00:00:00.000Z",
  updatedAt: "2024-01-01T00:00:00.000Z",
});

describe("archiveWorkspace", () => {
  test("sets status to archived and stamps archivedAt", async () => {
    const workspace = makeWorkspace("active");
    let written: WorkspaceRecord | undefined;
    const deps = {
      readWorkspace: async () => workspace,
      writeWorkspace: async (_paths: CraigPaths, w: WorkspaceRecord) => { written = w; },
    };
    const result = await archiveWorkspace(makePaths(), "workspace_repo_foo", deps);
    expect(result.status).toBe("archived");
    expect(written?.status).toBe("archived");
    expect(typeof written?.archivedAt).toBe("string");
  });
});
