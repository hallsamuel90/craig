import { describe, expect, test } from "vitest";

import { validateCraigIndex } from "./index-store.js";

describe("validateCraigIndex", () => {
  const base = {
    version: 2 as const,
    workspaceRoot: "/workspace",
    repoIds: [],
    workspaceIds: [],
    taskIds: [],
    jobIds: [],
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
  };

  test("accepts a valid index", () => {
    expect(validateCraigIndex(base, "/workspace", "/workspace/.craig/index.json")).toEqual(base);
  });

  test("throws when workspaceRoot does not match", () => {
    expect(() => validateCraigIndex(base, "/other", "/workspace/.craig/index.json")).toThrow(/belongs to/);
  });

  test("throws on wrong version", () => {
    expect(() => validateCraigIndex({ ...base, version: 1 }, "/workspace", "/f.json")).toThrow();
  });

  test("throws on non-string repoId entries", () => {
    expect(() => validateCraigIndex({ ...base, repoIds: [42] }, "/workspace", "/f.json")).toThrow();
  });
});
