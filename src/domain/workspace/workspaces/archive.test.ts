import { describe, expect, test } from "vitest";

import type { CraigPaths } from "../../../state/craig-paths.js";
import type { CraigUiRuntime } from "../../../types/workspace.js";
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

const makeUiState = (selectedWorkspaceId: string | null): CraigUiRuntime => ({
  version: 1,
  selectedWorkspaceId,
  selectedRepoId: "r",
  selectedTaskId: null,
  updatedAt: "2024-01-01T00:00:00.000Z",
});

describe("archiveWorkspace", () => {
  test("sets status to archived and stamps archivedAt", async () => {
    const workspace = makeWorkspace("active");
    let written: WorkspaceRecord | undefined;
    const deps = {
      readWorkspace: async () => workspace,
      writeWorkspace: async (_paths: CraigPaths, w: WorkspaceRecord) => { written = w; },
      readUiState: async () => null,
      writeUiState: async () => undefined,
    };
    const result = await archiveWorkspace(makePaths(), "workspace_repo_foo", deps);
    expect(result.status).toBe("archived");
    expect(written?.status).toBe("archived");
    expect(typeof written?.archivedAt).toBe("string");
  });

  test("clears UI selection when workspace was selected", async () => {
    const workspace = makeWorkspace("active");
    let clearedUi: CraigUiRuntime | undefined;
    const deps = {
      readWorkspace: async () => workspace,
      writeWorkspace: async () => undefined,
      readUiState: async () => makeUiState("workspace_repo_foo"),
      writeUiState: async (_paths: unknown, ui: CraigUiRuntime) => { clearedUi = ui; },
    };
    await archiveWorkspace(makePaths(), "workspace_repo_foo", deps);
    expect(clearedUi?.selectedWorkspaceId).toBeNull();
  });

  test("does not clear UI selection when a different workspace is selected", async () => {
    const workspace = makeWorkspace("active");
    let writeUiCalled = false;
    const deps = {
      readWorkspace: async () => workspace,
      writeWorkspace: async () => undefined,
      readUiState: async () => makeUiState("workspace_repo_bar"),
      writeUiState: async () => { writeUiCalled = true; },
    };
    await archiveWorkspace(makePaths(), "workspace_repo_foo", deps);
    expect(writeUiCalled).toBe(false);
  });
});
