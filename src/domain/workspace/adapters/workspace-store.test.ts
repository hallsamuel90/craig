import { describe, expect, test } from "vitest";

import { validateWorkspaceRecord } from "./workspace-store.js";

describe("validateWorkspaceRecord", () => {
  const base = {
    id: "workspace_repo_foo",
    kind: "repo" as const,
    name: "foo",
    rootPath: "/foo",
    primaryRepoId: "repo_foo",
    repoId: "repo_foo",
    discoveredRepoIds: ["repo_foo"],
    branch: "main",
    status: "active" as const,
    linkedRepoIds: [] as string[],
    archivedAt: null,
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
  };

  test("accepts a valid record", () => {
    expect(validateWorkspaceRecord(base, "/some/file.json")).toEqual(base);
  });

  test("throws on missing id", () => {
    const { kind, name, rootPath, primaryRepoId, branch, status, linkedRepoIds, archivedAt, createdAt, updatedAt } = base;
    expect(() =>
      validateWorkspaceRecord({ kind, name, rootPath, primaryRepoId, branch, status, linkedRepoIds, archivedAt, createdAt, updatedAt }, "/f.json"),
    ).toThrow();
  });

  test("throws on invalid status", () => {
    expect(() => validateWorkspaceRecord({ ...base, status: "unknown" }, "/f.json")).toThrow();
  });

  test("normalizes missing kind to repo", () => {
    const { id, name, rootPath, primaryRepoId, branch, status, linkedRepoIds, archivedAt, createdAt, updatedAt } = base;
    const result = validateWorkspaceRecord({ id, name, rootPath, primaryRepoId, branch, status, linkedRepoIds, archivedAt, createdAt, updatedAt }, "/f.json");
    expect(result.kind).toBe("repo");
  });

  test("normalizes missing name from primaryRepoId", () => {
    const { id, kind, rootPath, primaryRepoId, branch, status, linkedRepoIds, archivedAt, createdAt, updatedAt } = base;
    const result = validateWorkspaceRecord({ id, kind, rootPath, primaryRepoId, branch, status, linkedRepoIds, archivedAt, createdAt, updatedAt }, "/f.json");
    expect(typeof result.name).toBe("string");
  });

  test("normalizes missing linkedRepoIds to empty array", () => {
    const { id, kind, name, rootPath, primaryRepoId, branch, status, archivedAt, createdAt, updatedAt } = base;
    const result = validateWorkspaceRecord({ id, kind, name, rootPath, primaryRepoId, branch, status, archivedAt, createdAt, updatedAt }, "/f.json");
    expect(result.linkedRepoIds).toEqual([]);
  });
});
