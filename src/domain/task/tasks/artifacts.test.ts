import { describe, it, expect } from "vitest";
import { resolveArtifactPath } from "./artifacts.js";
import type { CraigPaths } from "../../../state/craig-paths.js";
import { getCraigPaths } from "../../../state/craig-paths.js";

const makePaths = (): CraigPaths => getCraigPaths("/workspace");

describe("resolveArtifactPath", () => {
  it("returns null for null input", () => {
    expect(resolveArtifactPath(makePaths(), null)).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(resolveArtifactPath(makePaths(), "")).toBeNull();
  });

  it("returns absolute paths as-is", () => {
    expect(resolveArtifactPath(makePaths(), "/abs/path/file.json")).toBe("/abs/path/file.json");
  });

  it("resolves relative paths against repoRoot", () => {
    const paths = makePaths();
    const result = resolveArtifactPath(paths, ".craig/artifacts/task_01/pr-status.json");
    expect(result).toBe(`${paths.repoRoot}/.craig/artifacts/task_01/pr-status.json`);
  });
});
