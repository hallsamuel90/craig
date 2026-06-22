import { describe, it, expect } from "vitest";
import { readErrorLog, readRecentErrorLines } from "./error-store.js";
import type { CraigPaths } from "../../../state/craig-paths.js";
import { getCraigPaths } from "../../../state/craig-paths.js";

const makePaths = (): CraigPaths => getCraigPaths("/workspace");

describe("readRecentErrorLines", () => {
  it("delegates to readErrorLog behavior", async () => {
    const paths = makePaths();
    const nonExistentPaths = { ...paths, errorLogFile: "/tmp/craig-test-nonexistent-rrl.log" };
    const snapshot = await readRecentErrorLines(nonExistentPaths);
    expect(snapshot.empty).toBe(true);
    expect(snapshot.lines).toEqual([]);
  });
});

describe("readErrorLog", () => {
  it("returns an empty snapshot when file does not exist", async () => {
    const paths = makePaths();
    // Override the errorLogFile to a non-existent path
    const nonExistentPaths = { ...paths, errorLogFile: "/tmp/craig-test-nonexistent-error-log-xyz.log" };
    const snapshot = await readErrorLog(nonExistentPaths);
    expect(snapshot.empty).toBe(true);
    expect(snapshot.lines).toEqual([]);
    expect(snapshot.path).toBe(nonExistentPaths.errorLogFile);
  });
});
