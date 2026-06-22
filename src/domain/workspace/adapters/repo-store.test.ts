import { describe, expect, test } from "vitest";

import { validateRepoRecord } from "./repo-store.js";

describe("validateRepoRecord", () => {
  const base = {
    id: "repo_foo",
    name: "foo",
    rootPath: "/foo",
    defaultBranch: "main",
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
  };

  test("accepts a valid record", () => {
    expect(validateRepoRecord(base, "/f.json")).toEqual(base);
  });

  test("throws on missing id", () => {
    const { name, rootPath, defaultBranch, createdAt, updatedAt } = base;
    expect(() => validateRepoRecord({ name, rootPath, defaultBranch, createdAt, updatedAt }, "/f.json")).toThrow();
  });

  test("throws on null", () => {
    expect(() => validateRepoRecord(null, "/f.json")).toThrow();
  });

  test("throws on missing defaultBranch", () => {
    const { id, name, rootPath, createdAt, updatedAt } = base;
    expect(() => validateRepoRecord({ id, name, rootPath, createdAt, updatedAt }, "/f.json")).toThrow();
  });
});
